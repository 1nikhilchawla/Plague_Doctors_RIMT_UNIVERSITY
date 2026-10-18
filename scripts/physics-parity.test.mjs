import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("physics_parity", { timeout: 120_000 }, () => {
  // The runner script, not `npm run`, so the test needs no shell on Windows.
  const out = execFileSync(process.execPath, ["scripts/parity.mjs"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
  assert.match(out, /physics parity ok/);
});
