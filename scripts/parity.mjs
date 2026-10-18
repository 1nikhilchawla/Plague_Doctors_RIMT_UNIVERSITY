#!/usr/bin/env node
/**
 * Physics parity: regenerate the TypeScript fixtures, then check ml/physics.py
 * against them. Runs on Linux, macOS and Windows (python3, then python).
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// No __pycache__ in ml/: the check imports physics.py on every run.
const env = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
const run = (command, args) => spawnSync(command, args, { cwd: root, stdio: "inherit", env });

const exported = run(process.execPath, ["--experimental-strip-types", "--no-warnings", "scripts/export-fixtures.ts"]);
if (exported.status !== 0) process.exit(exported.status ?? 1);

for (const python of ["python3", "python"]) {
  const checked = run(python, [join("ml", "parity_test.py")]);
  if (checked.error?.code === "ENOENT") continue;
  // The Windows Store "python3" alias exits 9009 without running anything.
  if (checked.status === 9009) continue;
  process.exit(checked.status ?? 1);
}
console.error("parity: no python3 or python on PATH");
process.exit(127);
