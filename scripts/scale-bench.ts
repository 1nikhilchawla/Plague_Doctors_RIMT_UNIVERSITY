/**
 * Scale benchmark. Measures, on one thread:
 *   - the live incremental loop (engine.update + 2-hour forecast + spike risk)
 *     per CGM reading, for synthetic patients;
 *   - forecastAt latency on the simulated ward (the dashboard's forecast path);
 *   - rankPlans latency per patient (the plan simulator);
 *   - how long the app's data takes: hydrating the committed ward snapshot,
 *     building the three CGMacros participants, against fitting the ward and
 *     running the full cohort evaluation from scratch (scripts and tests only).
 * Compute only: no network or database time.
 *
 * Writes reports/scale.json (flat fields; the README Scale table prints them).
 * Run: node --experimental-strip-types scripts/scale-bench.ts [patients]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  forecastAt,
  getCohort,
  getSimWard,
  simWardFromSnapshot,
  type SimWardSnapshot,
} from "../src/lib/glucotwin/cohort.ts";
import { rankPlans } from "../src/lib/glucotwin/protocol.ts";
import { loadRealCohort } from "../src/lib/glucotwin/real/adapt.ts";
import { createState, forecast, update, type TwinState } from "../src/lib/glucotwin/engine.ts";
import { spikeProbability } from "../src/lib/glucotwin/physics.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATIENTS = Number(process.argv[2] ?? 3000);
const TICKS = 288; // one day of 5-minute readings
const bands = { 30: { q10: -12, q90: 12 }, 60: { q10: -20, q90: 20 }, 120: { q10: -28, q90: 28 } };

let seed = 42;
const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

function makePatient(): TwinState {
  return createState({
    carbSensitivity: 4 + rand() * 8,
    activityEffect: 8 + rand() * 10,
    fastingBaseline: 100 + rand() * 60,
    dawnAmp: rand() * 20,
    tauMin: 70 + rand() * 80,
  });
}

function runDay(states: TwinState[]): number {
  let alerts = 0;
  for (let t = 0; t < TICKS; t += 1) {
    const min = t * 5;
    for (let p = 0; p < states.length; p += 1) {
      let s = states[p]!;
      if (min === 480 || min === 780 || min === 1200) {
        s = update(s, {
          kind: "meal",
          min,
          carbs: 40 + rand() * 40,
          fiber: 4,
          protein: 12,
          fat: 10,
          name: "meal",
        });
      }
      if (min === 1260) s = update(s, { kind: "walk", min, durationMin: 20 });
      s = update(s, { kind: "reading", index: t, glucose: 90 + rand() * 90, gap: false });
      const curve = forecast(s, bands, 120);
      if (curve && s.glucose != null && spikeProbability(s.glucose, curve) >= 0.6) alerts += 1;
      states[p] = s;
    }
  }
  return alerts;
}

runDay(Array.from({ length: 200 }, makePatient)); // JIT warm-up
const states = Array.from({ length: PATIENTS }, makePatient);
const t0 = process.hrtime.bigint();
runDay(states);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const cycles = PATIENTS * TICKS;
const perSecond = cycles / (ms / 1000);
const stateBytes = states.reduce((n, s) => n + JSON.stringify(s).length, 0) / PATIENTS;

// What the app does on load (snapshot) and on the source toggle (CGMacros), against a cold fit.
const snapshotText = readFileSync(join(root, "src", "lib", "glucotwin", "ward_snapshot.json"), "utf8");
let mark = performance.now();
simWardFromSnapshot(JSON.parse(snapshotText) as SimWardSnapshot);
const snapshotHydrateMs = performance.now() - mark;
mark = performance.now();
await loadRealCohort(() =>
  import("../src/lib/glucotwin/real/demo_patients.json", { with: { type: "json" } }).then(
    (file) => file.default,
  ),
);
const realWardLoadMs = performance.now() - mark;
mark = performance.now();
getSimWard();
const simWardFitMs = performance.now() - mark;
mark = performance.now();
const cohort = getCohort();
const cohortEvalMs = performance.now() - mark;

// Plan simulator: rankPlans per patient (7 plans over the scored week).
const planTimes: number[] = [];
for (const model of cohort.patients) {
  const a = performance.now();
  rankPlans(model);
  planTimes.push(performance.now() - a);
}
planTimes.sort((a, b) => a - b);

// Dashboard path: forecastAt on every ward patient at 5-min steps across a day.
const latencies: number[] = [];
for (const model of cohort.patients) {
  for (let index = 14 * 288; index < 15 * 288; index += 1) {
    const a = process.hrtime.bigint();
    forecastAt(model, index);
    latencies.push(Number(process.hrtime.bigint() - a) / 1000);
  }
}
latencies.sort((a, b) => a - b);
const median = latencies[Math.floor(latencies.length / 2)]!;
const p95 = latencies[Math.floor(latencies.length * 0.95)]!;

const out = {
  measuredAt: new Date().toISOString().slice(0, 10),
  node: process.version,
  cpu: cpus()[0]?.model.trim() ?? "unknown",
  threads: 1,
  patients: PATIENTS,
  readingsPerPatient: TICKS,
  cycles,
  microsecondsPerReading: Math.round((1e6 / perSecond) * 10) / 10,
  readingsPerSecondOneThread: Math.round(perSecond),
  patientsPerThreadAt5MinCadence: Math.floor(perSecond * 300),
  meanStateBytes: Math.round(stateBytes),
  forecastAtMedianMicroseconds: Math.round(median),
  forecastAtP95Microseconds: Math.round(p95),
  rankPlansMedianMs: Math.round(planTimes[Math.floor(planTimes.length / 2)]! * 10) / 10,
  rankPlansMaxMs: Math.round(planTimes[planTimes.length - 1]! * 10) / 10,
  wardSnapshotKb: Math.round(snapshotText.length / 1024),
  wardSnapshotHydrateMs: Math.round(snapshotHydrateMs),
  realWardLoadMs: Math.round(realWardLoadMs),
  simWardFitMs: Math.round(simWardFitMs),
  cohortEvaluationMs: Math.round(cohortEvalMs),
  note: "Compute only, one thread, Node; excludes network and database time. Engine loop = update + 2-hour forecast + spike risk per reading. The app loads the ward snapshot (hydrate) and, on the toggle, the CGMacros file; the fit and the cohort evaluation run only in scripts and tests. Browser timings are in docs/CHANGELOG_EVAL.md.",
};
mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(join(root, "reports", "scale.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out));
