#!/usr/bin/env node
/**
 * `npm test`: every scripts/**\/*.test.mjs, then every src/**\/*.test.ts, with
 * node's test runner. Files are found here rather than by a shell glob, so the
 * same command works under sh and cmd.exe.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function find(dir, suffix) {
  return readdirSync(join(root, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
    .map((entry) => relative(root, join(entry.parentPath, entry.name)).split("\\").join("/"))
    .sort();
}

const suites = [
  { label: "scripts", files: find("scripts", ".test.mjs"), flags: [] },
  { label: "src", files: find("src", ".test.ts"), flags: ["--experimental-strip-types", "--no-warnings"] },
];

let failed = false;
for (const suite of suites) {
  if (!suite.files.length) continue;
  console.log(`\n# ${suite.label}: ${suite.files.length} files`);
  const result = spawnSync(process.execPath, [...suite.flags, "--test", ...suite.files], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) failed = true;
}
process.exit(failed ? 1 : 0);
