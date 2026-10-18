/**
 * Fails unless the 12-section submission README and its linked files match
 * the form. A missing unlisted demo video is a failure, not a warning.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function fail(message) {
  failures.push(message);
}

const readmePath = join(root, "README.md");
if (!existsSync(readmePath)) {
  fail("README.md is missing");
}
const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";

const headings = [
  "## 1. Team details",
  "## 2. College / Incubator information",
  "## 3. Project title",
  "## 4. Problem statement",
  "## 5. Healthcare use case",
  "## 6. Technical stack",
  "## 7. AI/ML model and framework details",
  "## 8. Demo video",
  "## 9. Open-source licence details",
  "## 10. Architecture diagram",
  "## 11. Presentation",
  "## 12. Public access",
];
let cursor = -1;
for (const heading of headings) {
  const at = readme.indexOf(heading);
  if (at < 0) fail(`Missing heading: ${heading}`);
  else if (at <= cursor) fail(`Heading out of order: ${heading}`);
  else cursor = at;
}

const withoutComments = readme.replace(/<!--[\s\S]*?-->/g, "");
const placeholder = withoutComments.match(/<[^>\n]+>/);
if (placeholder) fail(`Placeholder or HTML tag still in README: ${placeholder[0]}`);

const linkRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
for (const match of readme.matchAll(linkRe)) {
  const url = match[1] || match[2];
  if (!url || url.startsWith("http://") || url.startsWith("https://") || url.startsWith("mailto:") || url.startsWith("#")) {
    continue;
  }
  const file = decodeURIComponent(url.split("#")[0]);
  if (!file) continue;
  const path = join(root, file);
  if (!existsSync(path) || !statSync(path).isFile()) fail(`README link does not resolve to a file: ${url}`);
}

for (const required of ["LICENSE", "DATA_LICENSES.md"]) {
  if (!existsSync(join(root, required))) fail(`${required} is missing`);
}

const archPdf = join(root, "docs/architecture/GlucoTwin_Architecture.pdf");
if (!existsSync(archPdf)) fail("Architecture PDF is missing");
else {
  const counted = spawnSync("python3", ["-c", "import pypdf,sys; print(len(pypdf.PdfReader(sys.argv[1]).pages))", archPdf], {
    encoding: "utf8",
  });
  if (counted.status !== 0) fail(`Could not read architecture PDF: ${counted.stderr}`);
  else if (counted.stdout.trim() !== "1") fail(`Architecture PDF must be 1 page, got ${counted.stdout.trim()}`);
}

const slides = join(root, "docs/presentation/GlucoTwin_Presentation.pdf");
if (!existsSync(slides)) fail("Presentation PDF is missing");

const videoSection = (readme.split("## 8. Demo video")[1] || "").split("## 9.")[0];
const ids = [...videoSection.matchAll(/https?:\/\/(?:www\.)?(?:youtu\.be\/|youtube\.com\/watch\?v=)([A-Za-z0-9_-]{6,})/g)].map(
  (match) => match[1],
);
const banned = new Set(["VIDEO_ID", "video_id", "placeholder", "yourid", "xxxx", "xxxxxxxxxxx"]);
const realIds = ids.filter((id) => !banned.has(id) && !id.includes("PLACEHOLDER") && !/^x+$/i.test(id));
if (!realIds.length) fail("README section 8 has no real youtu.be or youtube.com/watch?v= link");

// The form asks for a 15-20 minute demo: section 8 must state "**Length:** mm:ss" in that range.
const length = videoSection.match(/\*\*Length:\*\*\s*(\d{1,2}):(\d{2})/);
const seconds = length ? Number(length[1]) * 60 + Number(length[2]) : null;
if (seconds == null) fail('README section 8 has no "**Length:** mm:ss" for the demo video');
else if (seconds < 15 * 60 || seconds > 20 * 60 + 59) fail(`Demo video is ${length[1]}:${length[2]}; the form asks for 15-20 minutes`);

if (existsSync(join(root, ".gitmodules"))) fail(".gitmodules is present");
if (existsSync(join(root, ".gitattributes"))) {
  const text = readFileSync(join(root, ".gitattributes"), "utf8");
  if (/filter=lfs|git-lfs/i.test(text)) fail(".gitattributes contains Git LFS rules");
}

const limit = 50 * 1024 * 1024;
const large = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    // The `.cgmacros/` PhysioNet cache (≈ 660 MB) is never committed.
    if (name === ".cgmacros") continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (stat.size > limit) large.push({ rel: relative(root, path).split(sep).join("/"), size: stat.size });
  }
}
walk(root);

// Large files that .gitignore keeps out of the push (video renders, for example) are fine.
// Ask git; before `git init`, use a throwaway git dir in the system temp folder.
function gitIgnored(paths) {
  if (!paths.length) return new Set();
  const own = existsSync(join(root, ".git"));
  const gitDir = own ? join(root, ".git") : mkdtempSync(join(tmpdir(), "glucotwin-ignore-"));
  if (!own) spawnSync("git", ["--git-dir", gitDir, "init", "-q"]);
  const result = spawnSync("git", ["--git-dir", gitDir, "--work-tree", root, "check-ignore", "--stdin"], {
    input: paths.join("\n"),
    encoding: "utf8",
  });
  if (!own) rmSync(gitDir, { recursive: true, force: true });
  return new Set((result.stdout || "").split(/\r?\n/).filter(Boolean));
}
const ignored = gitIgnored(large.map((file) => file.rel));
for (const file of large) {
  if (!ignored.has(file.rel)) fail(`File larger than 50 MB would be pushed: ${file.rel} (${file.size} bytes)`);
}

if (failures.length) {
  console.error(`check:submission failed (${failures.length})`);
  for (const message of failures) console.error(`- ${message}`);
  process.exit(1);
}
console.log("check:submission passed");
