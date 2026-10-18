/**
 * Serializable twin state. update() is O(1) in the length of the stream:
 * it keeps only meals and walks that can still affect glucose, a fixed drift
 * ring, and running sums. forecast() uses the same curve as the batch twin
 * when adaptation is off.
 */

import {
  STEP_MIN,
  forecastCurve,
  levelAt,
  orderQuantiles,
  type BandOffset,
  type CurvePoint,
  type MacroEvent,
  type TwinKnobs,
  type WalkEvent,
} from "./physics.ts";

export const MODEL_VERSION = "glucotwin-engine-1";

const MEAL_MEMORY_MIN = 360;
const WALK_TAIL_MIN = 180;
const DRIFT_WINDOW = 144;
const COVERAGE_WINDOW = 288;
const Q_BIAS = 0.4;
const R_BIAS = 16;

export type TwinReading = { kind: "reading"; index: number; glucose: number | null; gap: boolean };
export type TwinMeal = { kind: "meal"; min: number; carbs: number; fiber: number; protein: number; fat: number; name: string };
export type TwinWalk = { kind: "walk"; min: number; durationMin: number };
export type TwinEvent = TwinReading | TwinMeal | TwinWalk;

export type TwinState = {
  version: string;
  knobs: TwinKnobs;
  startKnobs: TwinKnobs;
  bias: number;
  biasVar: number;
  index: number;
  nowMin: number;
  glucose: number | null;
  meals: MacroEvent[];
  walks: WalkEvent[];
  outside: number[];
  outsideSum: number;
  hotRun: number;
  coolRun: number;
  driftStart: number | null;
  driftRecovered: number | null;
  lastCalibrationIndex: number | null;
  residualSum: number;
  residualN: number;
  coverageRing: number[];
  coverageSum: number;
  updates: number;
};

export type TwinHealth = {
  version: string;
  lastCalibrationIndex: number | null;
  knobDelta: TwinKnobs;
  coverage24h: number | null;
  drift: "in-sync" | "out-of-sync" | "recovered";
  bias: number;
  updates: number;
  bounds: string;
};

function clip(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function clampKnobs(knobs: TwinKnobs): TwinKnobs {
  return {
    carbSensitivity: clip(knobs.carbSensitivity, 0.5, 40),
    activityEffect: clip(knobs.activityEffect, 0, 80),
    fastingBaseline: clip(knobs.fastingBaseline, 70, 220),
    dawnAmp: clip(knobs.dawnAmp, 0, 40),
    tauMin: clip(knobs.tauMin, 40, 240),
  };
}

export function createState(knobs: TwinKnobs): TwinState {
  const start = clampKnobs(knobs);
  return {
    version: MODEL_VERSION,
    knobs: start,
    startKnobs: { ...start },
    bias: 0,
    biasVar: 4,
    index: -1,
    nowMin: 0,
    glucose: null,
    meals: [],
    walks: [],
    outside: [],
    outsideSum: 0,
    hotRun: 0,
    coolRun: 0,
    driftStart: null,
    driftRecovered: null,
    lastCalibrationIndex: null,
    residualSum: 0,
    residualN: 0,
    coverageRing: [],
    coverageSum: 0,
    updates: 0,
  };
}

function bandAt(ahead: number, bands: Record<30 | 60 | 120, BandOffset>): BandOffset {
  const mix = (a: BandOffset, b: BandOffset, t: number): BandOffset => ({
    q10: a.q10 + (b.q10 - a.q10) * t,
    q90: a.q90 + (b.q90 - a.q90) * t,
  });
  if (ahead <= 0) return { q10: 0, q90: 0 };
  if (ahead <= 30) return mix({ q10: 0, q90: 0 }, bands[30], ahead / 30);
  if (ahead <= 60) return mix(bands[30], bands[60], (ahead - 30) / 30);
  return mix(bands[60], bands[120], Math.min(1, (ahead - 60) / 60));
}

function prune(state: TwinState, nowMin: number): void {
  state.meals = state.meals.filter((meal) => nowMin - meal.min < MEAL_MEMORY_MIN);
  state.walks = state.walks.filter((walk) => nowMin - walk.min < walk.durationMin + WALK_TAIL_MIN);
}

function pushRing(ring: number[], sum: number, value: number, cap: number): { ring: number[]; sum: number } {
  const next = ring.length >= cap ? ring.slice(1) : ring.slice();
  const dropped = ring.length >= cap ? ring[0]! : 0;
  next.push(value);
  return { ring: next, sum: sum - dropped + value };
}

/** Re-estimate from the day's residual mean. Each knob move is clamped, then the knob itself is clamped. */
function recalibrate(state: TwinState, index: number): void {
  if (state.residualN < 12) {
    state.residualSum = 0;
    state.residualN = 0;
    return;
  }
  const mean = state.residualSum / state.residualN;
  const fastingStep = clip(mean * 0.15, -8, 8);
  const carbStep = clip(mean * 0.02, -1.5, 1.5);
  const dawnStep = clip(mean * 0.05, -2, 2);
  state.knobs = clampKnobs({
    ...state.knobs,
    fastingBaseline: state.knobs.fastingBaseline + fastingStep,
    carbSensitivity: state.knobs.carbSensitivity + carbStep,
    dawnAmp: state.knobs.dawnAmp + dawnStep,
  });
  state.lastCalibrationIndex = index;
  state.residualSum = 0;
  state.residualN = 0;
}

export function update(state: TwinState, event: TwinEvent, adapt = true): TwinState {
  const next: TwinState = {
    ...state,
    knobs: { ...state.knobs },
    startKnobs: state.startKnobs,
    meals: state.meals,
    walks: state.walks,
    outside: state.outside,
    coverageRing: state.coverageRing,
    updates: state.updates + 1,
  };
  if (event.kind === "meal") {
    next.meals = [
      ...state.meals,
      { min: event.min, carbs: event.carbs, fiber: event.fiber, protein: event.protein, fat: event.fat, name: event.name },
    ];
    prune(next, next.nowMin);
    return next;
  }
  if (event.kind === "walk") {
    next.walks = [...state.walks, { min: event.min, durationMin: event.durationMin }];
    prune(next, next.nowMin);
    return next;
  }
  next.index = event.index;
  next.nowMin = event.index * STEP_MIN;
  prune(next, next.nowMin);
  if (adapt && event.index > 0 && event.index % 288 === 0) recalibrate(next, event.index);
  if (event.gap || event.glucose == null) {
    next.glucose = null;
    return next;
  }
  const physiology = levelAt(next.nowMin, next.meals, next.walks, next.knobs);
  const residual = event.glucose - physiology;
  if (adapt) {
    next.biasVar += Q_BIAS;
    const gain = next.biasVar / (next.biasVar + R_BIAS);
    next.bias = clip(next.bias + gain * (residual - next.bias), -40, 40);
    next.biasVar = (1 - gain) * next.biasVar;
    next.residualSum += residual - next.bias;
    next.residualN += 1;
  }
  next.glucose = event.glucose;
  const predicted = physiology + (adapt ? next.bias : 0);
  const miss = Math.abs(event.glucose - predicted) > 18 ? 1 : 0;
  const outside = pushRing(next.outside, next.outsideSum, miss, DRIFT_WINDOW);
  next.outside = outside.ring;
  next.outsideSum = outside.sum;
  const hotNow = next.outside.length >= DRIFT_WINDOW && next.outsideSum / next.outside.length > 0.35;
  if (next.driftStart == null) {
    next.hotRun = hotNow ? next.hotRun + 1 : 0;
    if (next.hotRun >= 72) next.driftStart = event.index - 71;
  } else if (next.driftRecovered == null) {
    next.coolRun = hotNow ? 0 : next.coolRun + 1;
    if (next.coolRun >= 72) {
      next.driftRecovered = event.index - 71;
      if (adapt) recalibrate(next, event.index);
    }
  }
  const covered = pushRing(next.coverageRing, next.coverageSum, miss ? 0 : 1, COVERAGE_WINDOW);
  next.coverageRing = covered.ring;
  next.coverageSum = covered.sum;
  return next;
}

export function forecast(
  state: TwinState,
  bands: Record<30 | 60 | 120, BandOffset>,
  horizonMin = 120,
): CurvePoint[] | null {
  if (state.glucose == null) return null;
  const base = forecastCurve({
    nowMin: state.nowMin,
    glucoseNow: state.glucose,
    meals: state.meals,
    walks: state.walks,
    knobs: state.knobs,
    band: { q10: 0, q90: 0 },
    horizonMin,
  });
  return base.map((point) => {
    const band = bandAt(point.minutesAhead, bands);
    const center = point.p50 + state.bias * (1 - Math.exp(-point.minutesAhead / Math.max(30, state.knobs.tauMin)));
    const [p10, p50, p90] = orderQuantiles(center + band.q10, center, center + band.q90);
    return { minutesAhead: point.minutesAhead, p10, p50, p90 };
  });
}

export function health(state: TwinState): TwinHealth {
  const drift =
    state.driftStart != null && state.driftRecovered == null
      ? "out-of-sync"
      : state.driftRecovered != null
        ? "recovered"
        : "in-sync";
  return {
    version: state.version,
    lastCalibrationIndex: state.lastCalibrationIndex,
    knobDelta: {
      carbSensitivity: state.knobs.carbSensitivity - state.startKnobs.carbSensitivity,
      activityEffect: state.knobs.activityEffect - state.startKnobs.activityEffect,
      fastingBaseline: state.knobs.fastingBaseline - state.startKnobs.fastingBaseline,
      dawnAmp: state.knobs.dawnAmp - state.startKnobs.dawnAmp,
      tauMin: state.knobs.tauMin - state.startKnobs.tauMin,
    },
    coverage24h: state.coverageRing.length ? state.coverageSum / state.coverageRing.length : null,
    drift,
    bias: state.bias,
    updates: state.updates,
    bounds: "carb 0.5–40, activity 0–80, fasting 70–220, dawn 0–40, tau 40–240; each night move is capped",
  };
}

/** Replay logged events up to one index. The published fit does not call this. */
export function replayHealth(input: {
  knobs: TwinKnobs;
  untilIndex: number;
  readings: { glucose: number | null; gap: boolean }[];
  meals: { min: number; carbs: number; fiber: number; protein: number; fat: number; name: string }[];
  walks: { min: number; durationMin: number }[];
}): TwinHealth {
  let state = createState(input.knobs);
  const meals = [...input.meals].sort((a, b) => a.min - b.min);
  const walks = [...input.walks].sort((a, b) => a.min - b.min);
  let mealI = 0;
  let walkI = 0;
  const last = Math.max(-1, Math.min(input.untilIndex, input.readings.length - 1));
  for (let index = 0; index <= last; index += 1) {
    const nowMin = index * STEP_MIN;
    while (mealI < meals.length && meals[mealI]!.min <= nowMin) {
      const meal = meals[mealI]!;
      state = update(state, {
        kind: "meal",
        min: meal.min,
        carbs: meal.carbs,
        fiber: meal.fiber,
        protein: meal.protein,
        fat: meal.fat,
        name: meal.name,
      });
      mealI += 1;
    }
    while (walkI < walks.length && walks[walkI]!.min <= nowMin) {
      const walk = walks[walkI]!;
      state = update(state, { kind: "walk", min: walk.min, durationMin: walk.durationMin });
      walkI += 1;
    }
    const reading = input.readings[index];
    const gap = !reading || reading.gap || reading.glucose == null;
    state = update(state, {
      kind: "reading",
      index,
      glucose: gap ? null : reading!.glucose,
      gap,
    });
  }
  return health(state);
}
