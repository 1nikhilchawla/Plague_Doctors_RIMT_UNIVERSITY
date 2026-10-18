/**
 * Writes reports/drug_guard_calibration.json: the sulfonylurea low guard chosen
 * on an independent realization of the simulated ward (persona seeds +
 * CALIBRATION_SEED_OFFSET), never on the scored seed. DRUG_LOW_GUARD in
 * cohort.ts must equal `chosen`; `npm test` checks it.
 * Run: node --experimental-strip-types scripts/calibrate-drug-guard.ts
 */
import { writeFileSync } from "node:fs";
import { calibrateDrugGuard, DRUG_LOW_GUARD } from "../src/lib/glucotwin/cohort.ts";

const started = performance.now();
const result = calibrateDrugGuard();
writeFileSync(
  new URL("../reports/drug_guard_calibration.json", import.meta.url),
  `${JSON.stringify(result, null, 2)}\n`,
);
const matches = JSON.stringify(result.chosen) === JSON.stringify(DRUG_LOW_GUARD);
console.log(
  `calibrated on ${result.patientId}, days ${result.days.join("–")} of seed offset ${result.seedOffset}: ` +
    `${result.lowEvents} lows, chosen ${JSON.stringify(result.chosen)} ` +
    `(${Math.round(performance.now() - started)} ms)${matches ? "" : " — DRUG_LOW_GUARD differs, update cohort.ts"}`,
);
