import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { foodMacros, sumMacros } from "./foods.ts";
import {
  availableIndex,
  forecastAt,
  getCohort,
  indexToMs,
  isStreamStale,
  SERIES_LEN,
  STEPS_PER_DAY,
  nightReview,
  riskAt,
  traceNow,
  type PatientModel,
} from "./cohort.ts";
import {
  activityWhenWorn,
  clarkeZone,
  clinicalNote,
  extractNumbers,
  featuresAt,
  findGlucoseEvents,
  forecastCurve,
  gammaMealOffset,
  hba1cPercentToMmol,
  homaIr,
  hygieneFires,
  lowOnset,
  mealOffset,
  mmolToMgdl,
  numbersAreAllowed,
  orderQuantiles,
  peakOf,
  scoreAlertEvents,
  spikeOnset,
  STEP_MIN,
  type TwinKnobs,
} from "./physics.ts";

const knobs: TwinKnobs = {
  carbSensitivity: 12,
  activityEffect: 18,
  fastingBaseline: 140,
  dawnAmp: 8,
  tauMin: 140,
};

describe("foods", () => {
  it("scales IFCT atta to a 30 g chapati", () => {
    const macros = foodMacros("atta", 1);
    assert.ok(macros);
    assert.equal(macros.carbs, 19.25);
    assert.equal(macros.fiber, 3.41);
  });

  it("refuses unverified dishes", () => {
    assert.equal(foodMacros("idli", 1), null);
    const summed = sumMacros([{ foodId: "idli", servings: 1 }]);
    assert.equal(summed.unresolved.length, 1);
  });
});

describe("units and labels", () => {
  it("converts mmol/L and HbA1c", () => {
    assert.equal(mmolToMgdl(10), 180);
    assert.ok(Math.abs(hba1cPercentToMmol(6.5) - 47.54) < 0.02);
    assert.ok(Math.abs((homaIr(90, 10) ?? 0) - (90 * 10) / 405) < 1e-9);
    assert.equal(homaIr(90, 0), null);
  });

  it("matches spike and low onset rules", () => {
    assert.equal(spikeOnset(150, 190), true);
    assert.equal(spikeOnset(100, 149), false);
    assert.equal(spikeOnset(120, 171), true);
    assert.equal(spikeOnset(190, 240), false);
    assert.equal(lowOnset(90, 65, false), true);
    assert.equal(lowOnset(90, 65, true), false);
    assert.equal(lowOnset(60, 50, false), false);
  });

  it("keeps quantiles ordered inside 40–400", () => {
    assert.deepEqual(orderQuantiles(120, 90, 110), [90, 110, 120]);
    const clipped = orderQuantiles(410, 395, 420);
    assert.ok(clipped[0] <= clipped[1] && clipped[1] <= clipped[2]);
    assert.ok(clipped.every((value) => value >= 40 && value <= 400));
  });

  it("zones the Clarke grid for obvious pairs", () => {
    assert.equal(clarkeZone(100, 108), "A");
    assert.equal(clarkeZone(60, 200), "E");
    assert.equal(clarkeZone(220, 55), "E");
  });
});

describe("features and what-if", () => {
  it("ignores anything after t", () => {
    const glucose = [
      { min: 0, value: 100 },
      { min: 30, value: 110 },
      { min: 90, value: 220 },
    ];
    const meals = [
      { min: 10, carbs: 25 },
      { min: 100, carbs: 80 },
    ];
    const before = featuresAt({ nowMin: 40, glucose, meals });
    glucose[2]!.value = 40;
    meals[1]!.carbs = 1;
    const after = featuresAt({ nowMin: 40, glucose, meals });
    assert.deepEqual(before, after);
    assert.equal(before.lastCarbs, 25);
  });

  it("raises the peak with carbs, lowers it with a walk, and is deterministic", () => {
    const now = 14 * 1440 + 12 * 60;
    const meals = [{ min: now - 15, carbs: 45, fiber: 3, protein: 8, fat: 4, name: "lunch" }];
    const extra = [...meals, { min: now + 10, carbs: 35, fiber: 2, protein: 4, fat: 1, name: "extra" }];
    const band = { q10: -12, q90: 16 };
    const base = forecastCurve({ nowMin: now, glucoseNow: 150, meals, walks: [], knobs, band });
    const withCarbs = forecastCurve({ nowMin: now, glucoseNow: 150, meals: extra, walks: [], knobs, band });
    const withWalk = forecastCurve({
      nowMin: now,
      glucoseNow: 150,
      meals,
      walks: [{ min: now + 5, durationMin: 30 }],
      knobs,
      band,
    });
    const again = forecastCurve({ nowMin: now, glucoseNow: 150, meals, walks: [], knobs, band });
    assert.ok(peakOf(withCarbs) >= peakOf(base) - 1e-6);
    assert.ok(peakOf(withWalk) <= peakOf(base) + 1e-6);
    assert.deepEqual(base, again);
    for (const point of withCarbs) {
      assert.ok(point.p10 <= point.p50 && point.p50 <= point.p90);
      assert.ok(point.p10 >= 40 && point.p90 <= 400);
    }
  });
});

describe("alert hygiene", () => {
  it("suppresses, blocks gaps, and lets lows outrank spikes", () => {
    const day = [0, 0, 0, 0, 0, 1];
    const fires = hygieneFires(
      [
        { spike: 0.8, low: 0.1, gap: false, day: day[0]! },
        { spike: 0.9, low: 0.1, gap: false, day: day[1]! },
        { spike: 0.2, low: 0.2, gap: false, day: day[2]! },
        { spike: 0.9, low: 0.85, gap: false, day: day[3]! },
        { spike: 0.9, low: 0.1, gap: true, day: day[4]! },
        { spike: 0.9, low: 0.1, gap: false, day: day[5]! },
      ],
      2,
      8,
    );
    assert.deepEqual(fires, ["spike", null, null, "low", null, "spike"]);
  });
});

describe("non-wear and notes", () => {
  it("never writes zero activity for a removed sensor", () => {
    assert.equal(activityWhenWorn(false, 12), null);
    assert.equal(activityWhenWorn(true, 0), 0);
  });

  it("rejects a note that invents a number", () => {
    const note = clinicalNote({
      mean: 154,
      gmi: 7,
      tir: 61,
      tar: 36,
      tbr: 3,
      cv: 28,
      tirDelta: -4,
      fasting: 142,
      carbPer10: 11.2,
      days: 7,
    });
    assert.equal(note.source, "template");
    assert.equal(numbersAreAllowed(note.text, extractNumbers(note.text).concat([70, 180, 10])), true);
    assert.equal(numbersAreAllowed("Glucose will reach 999 mg/dL.", [154, 70]), false);
  });
});

describe("event scoring", () => {
  it("counts a lead, a false alert, a miss, and ignores a gap", () => {
    const points = Array.from({ length: 160 }, () => ({ glucose: 110, blocked: false }));
    points[30] = { glucose: 210, blocked: false };
    points[31] = { glucose: 190, blocked: false };
    points[32] = { glucose: 160, blocked: false };
    points[100] = { glucose: 220, blocked: false };
    for (let index = 120; index <= 130; index += 1) points[index] = { glucose: 250, blocked: true };
    points[140] = { glucose: 50, blocked: true };
    points[150] = { glucose: 62, blocked: false };
    const events = findGlucoseEvents(points, [{ index: 18, pre: 110 }]);
    assert.ok(events.spikes.includes(30));
    assert.ok(events.spikes.includes(100));
    assert.equal(events.spikes.some((index) => index >= 120 && index <= 130), false);
    assert.ok(events.lows.includes(150));
    assert.equal(events.lows.includes(140), false);
    const scored = scoreAlertEvents(events.spikes, events.lows, [
      { index: 22, kind: "spike" },
      { index: 55, kind: "spike" },
    ]);
    assert.equal(scored.spikeHits, 1);
    assert.deepEqual(scored.leads, [40]);
    assert.equal(scored.spikeFalse, 1);
    assert.equal(scored.spikeEvents - scored.spikeHits, 1);
  });
});

describe("no truth leak", () => {
  it("keeps hidden generator parameters out of estimation and scoring", () => {
    const src = readFileSync(new URL("./cohort.ts", import.meta.url), "utf8");
    for (const name of ["estimateParams", "fitBands", "buildAlerts", "scorePatient"]) {
      const start = src.indexOf(`function ${name}`);
      assert.ok(start >= 0, name);
      const next = src.indexOf("\nfunction ", start + 1);
      const body = src.slice(start, next === -1 ? src.length : next);
      assert.equal(body.includes(".true"), false, name);
    }
  });
});

describe("mismatched generator", () => {
  it("scores the ward on a curve the twin does not use", () => {
    const cohort = getCohort();
    assert.equal(cohort.generator, "mismatched");
    assert.equal(cohort.eval.generator, "mismatched");
    assert.equal(cohort.evalMatched.generator, "matched");
    assert.ok(cohort.eval.horizons.every((row) => row.n > 0));
    assert.ok(cohort.evalMatched.horizons.every((row) => row.n > 0));
    const fatty = gammaMealOffset(140, 55, 3, 28, 8, 12);
    const lean = gammaMealOffset(140, 55, 3, 4, 8, 12);
    assert.ok(fatty > lean);
    // The curves cross near 50 min; by 90 min the gamma tail has fallen well below the triangle.
    assert.ok(Math.abs(gammaMealOffset(90, 60, 2, 4, 8, 12) - mealOffset(90, 60, 2, 12)) > 10);
    assert.notEqual(cohort.eval.horizons[0]?.rmseTwin, cohort.evalMatched.horizons[0]?.rmseTwin);
  });
});

describe("cohort", () => {
  const cohort = getCohort();

  it("builds a strict 5-minute grid", () => {
    const model = cohort.patients[0]!;
    assert.equal(model.readings.length, SERIES_LEN);
    assert.equal(indexToMs(1) - indexToMs(0), 5 * 60 * 1000);
    const gap = cohort.patients.find((item) => item.patient.id === "GT-12")!;
    assert.ok(gap.readings.some((reading) => reading.cgmGap && reading.glucose == null));
    const off = cohort.patients.find((item) => item.patient.id === "GT-19")!;
    assert.ok(off.readings.some((reading) => reading.worn === false && reading.activityKcal === null));
    const press = cohort.patients.find((item) => item.patient.id === "GT-07")!;
    assert.ok(press.readings.some((reading) => reading.compressionLow));
  });

  it("keeps diagnoses consistent with the diabetes group", () => {
    for (const model of cohort.patients) {
      const diabetes = model.patient.diagnoses.includes("Type 2 diabetes mellitus");
      assert.equal(diabetes, model.patient.group === "t2d");
      assert.equal(model.patient.onMetformin, model.patient.group === "t2d");
      assert.equal(model.patient.simulated, true);
    }
  });

  it("beats persistence and produces both alert types", () => {
    const at60 = cohort.eval.horizons.find((row) => row.horizonMin === 60)!;
    const at120 = cohort.eval.horizons.find((row) => row.horizonMin === 120)!;
    assert.ok(at60.rmseTwin < at60.rmsePersistence);
    assert.ok(at120.rmseTwin < at120.rmsePersistence);
    assert.ok(cohort.patients.some((model) => model.alerts.some((alert) => alert.kind === "spike")));
    assert.ok(cohort.patients.some((model) => model.alerts.some((alert) => alert.kind === "low")));
    const suresh = cohort.patients.find((model) => model.patient.id === "GT-21")!;
    assert.equal(isStreamStale(suresh, cohort.demoIndex), true);
    assert.ok(availableIndex(suresh, cohort.demoIndex) < cohort.demoIndex);
  });

  it("matches the passive forecast when the edit is empty", () => {
    const model = cohort.patients[0]!;
    const index = cohort.demoIndex;
    const base = forecastAt(model, index);
    const same = forecastAt(model, index, { meal: null, walk: null, sleepHours: null });
    assert.deepEqual(base, same);
  });

  it("splits glucose into pieces that add back up", () => {
    const model = cohort.patients.find((item) => item.patient.id === "GT-07")!;
    const index = 14 * STEPS_PER_DAY + Math.round((13 * 60 + 45) / STEP_MIN);
    const trace = traceNow(model, index);
    assert.ok(trace);
    assert.equal(trace.blocked, null);
    assert.ok(trace.glucose != null);
    const sum = trace.contributors.reduce((total, item) => total + item.mgdl, 0);
    assert.ok(Math.abs(sum - trace.glucose) < 0.05);
    assert.ok(trace.contributors.some((item) => item.kind === "meal"));
    assert.ok(trace.contributors.some((item) => item.kind === "residual"));
  });

  it("moves the later forecast when a hidden snack is treated as logged", () => {
    const model = cohort.patients.find((item) => item.patient.id === "GT-07")!;
    const index = 13 * STEPS_PER_DAY + Math.round((16 * 60 + 50) / STEP_MIN);
    const trace = traceNow(model, index);
    assert.ok(trace);
    assert.ok(trace.unlogged.length > 0);
    const logged = forecastAt(model, index);
    const informed = forecastAt(model, index, { includeUnlogged: true });
    assert.ok(logged && informed);
    const later = (curve: typeof logged, minutes: number) =>
      curve!.find((point) => point.minutesAhead === minutes)!.p50;
    assert.ok(Math.abs(later(logged, 60) - later(informed, 60)) > 1);
  });

  it("refuses to split a sensor gap", () => {
    const model = cohort.patients.find((item) => item.patient.id === "GT-12")!;
    const index = 4 * STEPS_PER_DAY + Math.round((11 * 60 + 20) / STEP_MIN);
    const trace = traceNow(model, index);
    assert.equal(trace?.blocked, "gap");
    assert.equal(forecastAt(model, index), null);
    assert.ok((trace?.today.gapMin ?? 0) > 0);
  });

  it("keeps the overnight review inside the clock", () => {
    const fatima = cohort.patients.find((item) => item.patient.id === "GT-19")!;
    const before = 14 * STEPS_PER_DAY + Math.round((7 * 60) / STEP_MIN);
    const open = nightReview(fatima, before, 7);
    assert.equal(open.rows[0]?.dayIndex, 14);
    assert.equal(open.rows[0]?.partial, true);
    assert.equal(open.rows[0]?.at8, null);
    assert.ok(open.rows.every((row) => row.dayIndex <= 14));
    const done = nightReview(fatima, 14 * STEPS_PER_DAY + Math.round((8 * 60) / STEP_MIN), 7);
    const morning = done.rows[0]!;
    assert.equal(morning.partial, false);
    assert.ok(morning.at4 != null && morning.at8 != null);
    assert.equal(morning.rise, morning.at8! - morning.at4!);
    assert.ok((done.medianRise ?? 0) > 0);
    const short = nightReview(fatima, 10 * STEPS_PER_DAY + Math.round((12 * 60) / STEP_MIN), 3);
    assert.ok(short.rows.some((row) => row.dayIndex === 10 && row.short));
    const ananya = cohort.patients.find((item) => item.patient.id === "GT-07")!;
    const pressed = nightReview(ananya, 2 * STEPS_PER_DAY + Math.round((12 * 60) / STEP_MIN), 3);
    assert.ok((pressed.rows.find((row) => row.dayIndex === 2)?.compressionMin ?? 0) > 0);
  });
});

describe("causal_forecast_and_risk", () => {
  it("keeps the forecast, its band and the alert risk at t unchanged when everything after t changes", () => {
    const cohort = getCohort();
    const model = cohort.patients.find((item) => item.patient.id === "GT-31")!;
    // Day 17 (1-indexed), 16:00: on the drug, inside the scored test days.
    let t = 16 * STEPS_PER_DAY + Math.round((16 * 60) / STEP_MIN);
    while (model.readings[t]?.glucose == null || model.readings[t]!.cgmGap) t += 1;
    const tMin = t * STEP_MIN;
    const day = Math.floor(tMin / 1440);
    const before = { curve: forecastAt(model, t), risk: riskAt(model, t) };
    assert.ok(before.curve && before.curve.length > 0);

    const later = model.meals.find((meal) => meal.min > tMin)!;
    const mutated: PatientModel = {
      ...model,
      readings: model.readings.map((reading, index) =>
        index > t && reading ? { ...reading, glucose: reading.glucose == null ? null : 400 - reading.glucose / 2 } : reading,
      ),
      meals: [
        ...model.meals.map((meal) => (meal.min > tMin ? { ...meal, carbs: meal.carbs * 3 } : meal)),
        { ...later, id: "future-meal", min: tMin + 30, carbs: 140, logged: true },
      ],
      walks: [
        ...model.walks.filter((walk) => walk.min <= tMin),
        { min: tMin + 20, durationMin: 60, logged: true, mets: 5 },
      ],
      nights: model.nights.map((night, index) =>
        index > day ? { ...night, durationH: 3, efficiency: 0.5, rmssd: 12 } : night,
      ),
    };
    assert.deepEqual(forecastAt(mutated, t), before.curve);
    assert.deepEqual(riskAt(mutated, t), before.risk);
    assert.deepEqual(mutated.bands, model.bands);

    // The check can fail: changing the reading at t itself moves the forecast.
    const atT: PatientModel = {
      ...model,
      readings: model.readings.map((reading, index) =>
        index === t && reading ? { ...reading, glucose: (reading.glucose ?? 100) + 40 } : reading,
      ),
    };
    assert.notDeepEqual(forecastAt(atT, t), before.curve);
  });
});
