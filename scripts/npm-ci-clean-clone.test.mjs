import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

test("npm_ci_clean_clone", { timeout: 180_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), "glucotwin-ci-"));
  try {
    cpSync(join(root, "package.json"), join(dir, "package.json"));
    cpSync(join(root, "package-lock.json"), join(dir, "package-lock.json"));
    // npm is npm.cmd on Windows, which needs a shell to start.
    const windows = process.platform === "win32";
    execFileSync(windows ? "npm.cmd" : "npm", ["ci", "--ignore-scripts"], {
      cwd: dir,
      stdio: "pipe",
      shell: windows,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
