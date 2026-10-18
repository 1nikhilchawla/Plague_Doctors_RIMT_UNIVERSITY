import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forecastCurve, STEP_MIN, type TwinKnobs } from "./physics.ts";
import { MODEL_VERSION, clampKnobs, createState, forecast, health, replayHealth, update } from "./engine.ts";

const KNOBS: TwinKnobs = {
  carbSensitivity: 12,
  activityEffect: 14,
  fastingBaseline: 140,
  dawnAmp: 22,
  tauMin: 150,
};

const BANDS = {
  30: { q10: -12, q90: 14 },
  60: { q10: -20, q90: 22 },
  120: { q10: -30, q90: 34 },
} as const;

describe("engine_incremental_equals_batch", () => {
  it("matches the batch median when adaptation is off", () => {
    const meal = { min: 8 * 60, carbs: 55, fiber: 6, protein: 10, fat: 8, name: "breakfast" };
    const walk = { min: 9 * 60, durationMin: 30 };
    let state = createState(KNOBS);
    state = update(state, { kind: "meal", ...meal }, false);
    state = update(state, { kind: "walk", ...walk }, false);
    const index = Math.round((10 * 60) / STEP_MIN);
    state = update(state, { kind: "reading", index, glucose: 128, gap: false }, false);
    assert.equal(state.bias, 0);
    const online = forecast(state, BANDS, 120);
    const batch = forecastCurve({
      nowMin: index * STEP_MIN,
      glucoseNow: 128,
      meals: [meal],
      walks: [walk],
      knobs: KNOBS,
      band: { q10: 0, q90: 0 },
      horizonMin: 120,
    });
    assert.ok(online);
    assert.equal(online.length, batch.length);
    for (let i = 0; i < online.length; i += 1) {
      assert.ok(Math.abs(online[i]!.p50 - batch[i]!.p50) < 1e-6);
    }
  });
});

describe("online_recalibration_bounded", () => {
  it("keeps each night step inside the documented caps and the knobs inside their clamps", () => {
    let state = createState(KNOBS);
    for (let index = 0; index <= 288; index += 1) {
      state = update(state, { kind: "reading", index, glucose: 220, gap: false }, true);
    }
    assert.equal(state.lastCalibrationIndex, 288);
    assert.ok(Math.abs(state.knobs.fastingBaseline - KNOBS.fastingBaseline) <= 8 + 1e-9);
    assert.ok(Math.abs(state.knobs.carbSensitivity - KNOBS.carbSensitivity) <= 1.5 + 1e-9);
    assert.ok(Math.abs(state.knobs.dawnAmp - KNOBS.dawnAmp) <= 2 + 1e-9);
    assert.equal(state.knobs.activityEffect, KNOBS.activityEffect);
    assert.equal(state.knobs.tauMin, KNOBS.tauMin);
    const edge = clampKnobs({
      carbSensitivity: 39.8,
      activityEffect: 0,
      fastingBaseline: 218,
      dawnAmp: 39,
      tauMin: 40,
    });
    let high = createState(edge);
    for (let index = 0; index <= 288; index += 1) {
      high = update(high, { kind: "reading", index, glucose: 400, gap: false }, true);
    }
    assert.ok(high.knobs.carbSensitivity <= 40 && high.knobs.carbSensitivity >= 0.5);
    assert.ok(high.knobs.fastingBaseline <= 220 && high.knobs.fastingBaseline >= 70);
    assert.ok(high.knobs.dawnAmp <= 40 && high.knobs.dawnAmp >= 0);
    assert.ok(high.knobs.tauMin <= 240 && high.knobs.tauMin >= 40);
    assert.ok(high.knobs.activityEffect <= 80 && high.knobs.activityEffect >= 0);
  });
});

describe("twin_health_fields", () => {
  it("reports version, coverage, drift, and the knob delta", () => {
    const fresh = health(createState(KNOBS));
    assert.equal(fresh.version, MODEL_VERSION);
    assert.equal(fresh.lastCalibrationIndex, null);
    assert.equal(fresh.drift, "in-sync");
    assert.equal(fresh.coverage24h, null);
    assert.equal(fresh.knobDelta.carbSensitivity, 0);
    assert.ok(fresh.bounds.includes("0.5"));
    const replayed = replayHealth({
      knobs: KNOBS,
      untilIndex: 2,
      readings: [
        { glucose: 140, gap: false },
        { glucose: null, gap: true },
        { glucose: 150, gap: false },
      ],
      meals: [],
      walks: [],
    });
    assert.equal(replayed.version, MODEL_VERSION);
    assert.ok(replayed.coverage24h != null && replayed.coverage24h >= 0 && replayed.coverage24h <= 1);
    assert.ok(replayed.updates > 0);
  });
});
