import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { forecastAt, getCohort, project, usualMeal } from "./cohort.ts";
import {
  driftWindows,
  ehrPrior,
  globalKnobs,
  interpolatePricks,
  knobsToward,
  maskedRmse,
  prickClocks,
  wilson,
} from "./ehr.ts";
import { formatHours } from "./format.ts";
import { clinicalNote, mgdlToMmol, mmolToMgdl, numbersAreAllowed, peakOf, STEP_MIN } from "./physics.ts";

describe("ehr_prior_ablation_runs", () => {
  it("scores four finite arms and does not read the hidden generator", () => {
    const source = readFileSync(new URL("./ehr.ts", import.meta.url), "utf8");
    assert.equal(source.includes(".true"), false);
    const prior = ehrPrior(
      { hba1c: 7.2, fastingGlucose: 140, fastingInsulin: 18, homaIr: 6.2, bmi: 29, age: 54, sex: "F" },
      () => 0.5,
    );
    assert.ok(prior.carbSensitivity >= 0.5 && prior.carbSensitivity <= 40);
    assert.ok(prior.fastingBaseline >= 70 && prior.fastingBaseline <= 220);
    const global = globalKnobs();
    assert.ok(Math.abs(global.carbSensitivity - (12 + 7.2 + 4.4) / 3) < 1e-9);
    const personal = knobsToward(
      { carbMean: 10, carbN: 4, actMean: 16, actN: 2, fastingMedian: 130 },
      prior,
    );
    assert.ok(personal.carbSensitivity !== prior.carbSensitivity);
    const cohort = getCohort();
    assert.deepEqual(
      cohort.ablation.map((arm) => arm.id),
      ["none", "group", "ehr", "ehrPersonal"],
    );
    for (const arm of cohort.ablation) {
      assert.ok(Number.isFinite(arm.rmse60));
      assert.ok(arm.n > 100);
    }
    const interval = wilson(7, 10);
    assert.ok(interval && interval[0] < 0.7 && interval[1] > 0.7);
    assert.equal(wilson(0, 0), null);
  });
});

describe("whatif_4h_horizon", () => {
  it("returns 49 points and holds the 2-hour band after 120 minutes", () => {
    const model = getCohort().patients.find((item) => item.patient.id === "GT-02")!;
    const index = 14 * 288 + 12 * 12;
    const curve = forecastAt(model, index, { horizonMin: 240 });
    assert.ok(curve);
    assert.equal(curve.length, 49);
    assert.equal(curve[0]!.minutesAhead, 0);
    assert.equal(curve.at(-1)!.minutesAhead, 240);
    const at120 = curve.find((point) => point.minutesAhead === 120)!;
    const at240 = curve.find((point) => point.minutesAhead === 240)!;
    assert.ok(Math.abs(at120.p90 - at120.p10 - (at240.p90 - at240.p10)) < 1e-6);
    const empty = forecastAt(model, index, { meal: null, walk: null, sleepHours: null, horizonMin: 120 });
    const plain = forecastAt(model, index);
    assert.deepEqual(empty, plain);
    assert.equal(plain?.length, 25);
  });
});

describe("median_inside_band", () => {
  it("keeps every median inside its 10–90 band, including a large meal", () => {
    const model = getCohort().patients[0]!;
    const index = 12 * 288 + 80;
    const curves = [
      forecastAt(model, index, { horizonMin: 240 }),
      forecastAt(model, index, {
        horizonMin: 240,
        meal: { inMin: 10, carbs: 150, fiber: 4, protein: 20, fat: 30, name: "large" },
      }),
    ];
    for (const curve of curves) {
      assert.ok(curve);
      for (const point of curve) {
        assert.ok(point.p10 <= point.p50 + 1e-9);
        assert.ok(point.p50 <= point.p90 + 1e-9);
      }
    }
  });
});

describe("drift_detected_and_recovered", () => {
  it("flags a long miss and ignores a short one", () => {
    const outside = Array.from({ length: 500 }, (_, index) => index <= 250);
    const drift = driftWindows(outside);
    assert.ok(drift.start != null);
    assert.ok(drift.recovered != null);
    assert.ok(drift.recovered > drift.start);
    const brief = Array.from({ length: 400 }, (_, index) => index >= 100 && index < 130);
    assert.equal(driftWindows(brief).start, null);
  });
});

describe("low_cost_mode_monotone", () => {
  it("fits a curve better as nested pricks increase, and the cohort is not worse at 8 than at 2", () => {
    const series = Array.from({ length: 288 * 3 }, (_, index) => 100 + ((index % 288) - 144) ** 2 / 80);
    const rmses = ([2, 4, 6, 8] as const).map((count) =>
      maskedRmse(series, interpolatePricks(series, STEP_MIN, prickClocks(count))),
    );
    for (let cursor = 1; cursor < rmses.length; cursor += 1) {
      assert.ok(rmses[cursor]! <= rmses[cursor - 1]! + 1e-9);
    }
    assert.ok(rmses[3]! < rmses[0]!);
    const costs = getCohort().lowCost;
    const two = costs.find((row) => row.pricks === 2)!;
    const eight = costs.find((row) => row.pricks === 8)!;
    const full = costs.find((row) => row.pricks === 288)!;
    assert.ok(eight.rmse <= two.rmse + 1e-9);
    assert.equal(full.rmse, 0);
  });
});

describe("sleep_display_rounded", () => {
  it("shows sleep to one decimal", () => {
    assert.equal(formatHours(6), "6.0");
    assert.match(formatHours(6.24), /^\d+\.\d$/);
    const night = getCohort().patients[0]!.nights[3]!;
    assert.match(formatHours(night.durationH), /^\d+\.\d$/);
  });
});

describe("adversarial forecasts", () => {
  it("handles a large meal, a fasting forecast, two walks, a gap, units, and an empty edit", () => {
    const model = getCohort().patients.find((item) => item.patient.id === "GT-07")!;
    const index = 14 * 288 + 140;
    const reading = model.readings[index]!;
    assert.ok(reading.glucose != null);
    const small = forecastAt(model, index, {
      meal: { inMin: 0, carbs: 20, fiber: 2, protein: 5, fat: 5, name: "small" },
    })!;
    const large = forecastAt(model, index, {
      meal: { inMin: 0, carbs: 120, fiber: 2, protein: 5, fat: 5, name: "large" },
    })!;
    const fatty = forecastAt(model, index, {
      meal: { inMin: 0, carbs: 20, fiber: 2, protein: 40, fat: 40, name: "fatty" },
    })!;
    assert.ok(peakOf(large) >= peakOf(small) - 1e-6);
    assert.deepEqual(
      fatty.map((point) => point.p50),
      small.map((point) => point.p50),
    );
    const fasting = forecastAt(model, index, { meal: null, walk: null, sleepHours: null })!;
    assert.equal(fasting.length, 25);
    assert.ok(fasting.every((point) => Number.isFinite(point.p50)));
    const now = index * STEP_MIN;
    const knobs = model.params.knobs;
    const oneWalk = project({
      nowMin: now,
      glucoseNow: reading.glucose!,
      meals: [],
      walks: [{ min: now + 10, durationMin: 30 }],
      knobs,
      bands: model.bands,
    });
    const twoWalks = project({
      nowMin: now,
      glucoseNow: reading.glucose!,
      meals: [],
      walks: [
        { min: now + 10, durationMin: 30 },
        { min: now + 50, durationMin: 30 },
      ],
      knobs,
      bands: model.bands,
    });
    assert.ok(peakOf(twoWalks) <= peakOf(oneWalk) + 1e-6);
    const gap = getCohort().patients.find((item) => item.patient.id === "GT-12")!;
    const gapIndex = gap.readings.findIndex((row) => row.cgmGap);
    assert.ok(gapIndex >= 0);
    assert.equal(forecastAt(gap, gapIndex), null);
    assert.equal(mmolToMgdl(mgdlToMmol(180)), 180);
    const note = clinicalNote({
      mean: 154,
      gmi: 6.9,
      tir: 70,
      tar: 28,
      tbr: 2,
      cv: 32,
      tirDelta: -4,
      fasting: 128,
      carbPer10: 11.2,
      days: 7,
    });
    assert.equal(note.source, "template");
    assert.equal(numbersAreAllowed("The magnitude was 22.", [154, 70]), false);
    const usual = usualMeal(model, 10 * 1440 + 7 * 60);
    if (usual) {
      assert.ok(usual.carbs > 0);
      assert.ok(usual.atMin > 10 * 1440 + 7 * 60);
    }
  });
});
