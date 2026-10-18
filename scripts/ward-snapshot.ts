/**
 * Writes src/lib/glucotwin/ward_snapshot.json: the fitted simulated ward the
 * app loads instead of fitting 11 twins in the browser. `npm test` fails when
 * the committed file no longer matches a fresh build.
 * Run: node --experimental-strip-types scripts/ward-snapshot.ts
 */
import { writeFileSync } from "node:fs";
import { getSimWard, simWardSnapshot } from "../src/lib/glucotwin/cohort.ts";

const started = performance.now();
const snapshot = simWardSnapshot(getSimWard());
const text = JSON.stringify(snapshot);
writeFileSync(new URL("../src/lib/glucotwin/ward_snapshot.json", import.meta.url), text);
console.log(
  `wrote src/lib/glucotwin/ward_snapshot.json (${Math.round(text.length / 1024)} KB, ${Math.round(performance.now() - started)} ms)`,
);
