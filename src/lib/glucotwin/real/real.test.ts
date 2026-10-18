import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { availableIndex, getCohort, SERIES_LEN } from "../cohort.ts";
import { getRealEval, loadRealCohort as loadWithLoader } from "./adapt.ts";

const loadRealCohort = () =>
  loadWithLoader(() =>
    import("./demo_patients.json", { with: { type: "json" } }).then((file) => file.default),
  );

describe("cgmacros", () => {
  it("shows a computed real table and three held-out participants", async () => {
    const real = getRealEval();
    assert.equal(real.dataset, "CGMacros");
    assert.equal(real.participants, 45);
    assert.equal(real.doi, "10.13026/3z8q-x658");
    assert.equal(real.licence, "CC BY-NC-SA 4.0");
    assert.equal(real.horizons.length, 3);
    assert.equal(
      real.groupCounts.healthy + real.groupCounts.prediabetes + real.groupCounts.t2d,
      real.participants,
    );
    for (const row of real.horizons) {
      assert.ok(Number.isFinite(row.rmseTwin));
      assert.ok(Number.isFinite(row.rmsePersistence));
      assert.ok(Number.isFinite(row.rmseLinear));
    }
    const ward = await loadRealCohort();
    assert.equal(ward.source, "cgmacros");
    assert.equal(ward.patients.length, 3);
    assert.deepEqual(
      ward.patients.map((model) => model.patient.group).sort(),
      ["healthy", "prediabetes", "t2d"],
    );
    for (const model of ward.patients) {
      assert.equal(model.patient.simulated, false);
      assert.ok(model.readings.length < SERIES_LEN);
      assert.equal(availableIndex(model, 1_000_000), model.readings.length - 1);
      assert.equal(model.nights[0]?.simulated, false);
      assert.equal(model.nights[0]?.durationH, 7);
    }
    const simulated = getCohort();
    assert.equal(simulated.patients[0]?.patient.simulated, true);
    assert.ok(simulated.patients[0]!.readings.length !== ward.patients[0]!.readings.length);
    const attribution = readFileSync(new URL("./ATTRIBUTION.md", import.meta.url), "utf8");
    assert.match(attribution, /10\.13026\/3z8q-x658/);
    assert.match(attribution, /CC BY-NC-SA 4\.0/);
  });

  it("replays the evaluator's choices: meal clock, trend correction and the low rule", async () => {
    const real = getRealEval();
    const ward = await loadRealCohort();
    assert.equal(typeof real.mealClock?.chosen, "boolean");
    for (const model of ward.patients) {
      assert.equal(model.params.knobs.mealClock, real.mealClock?.chosen);
      assert.ok(model.trend, `${model.patient.id} has no trend correction`);
      assert.deepEqual(model.alertSetup.lowTrend, real.lowRule?.chosen ?? null);
      // No zero-carb pseudo-meals from empty CSV cells.
      assert.ok(model.meals.length < 200, `${model.patient.id} has ${model.meals.length} meals`);
    }
  });
});
