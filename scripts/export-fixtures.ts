/**
 * Twenty input/output cases for the Python parity test. Generated, not hand-typed.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  clarkeZone,
  conformalBand,
  findGlucoseEvents,
  forecastCurve,
  hygieneFires,
  lowProbability,
  mealOffset,
  postWalkSensitivity,
  scoreAlertEvents,
  spikeProbability,
  trendLowRisk,
  twinLowRisk,
  walkOffset,
  wearableDawn,
  wearableSensitivity,
  type TwinKnobs,
} from "../src/lib/glucotwin/physics.ts";

const knobs: TwinKnobs = {
  carbSensitivity: 12,
  activityEffect: 18,
  fastingBaseline: 140,
  dawnAmp: 8,
  tauMin: 140,
};

const meals = [
  { min: 8 * 60, carbs: 55, fiber: 6, protein: 12, fat: 14, name: "breakfast" },
  { min: 13 * 60, carbs: 80, fiber: 4, protein: 18, fat: 22, name: "lunch" },
];
const walks = [{ min: 18 * 60, durationMin: 30 }];

const forecastCurveCases = Array.from({ length: 20 }, (_, i) => {
  const input = {
    nowMin: 7 * 60 + i * 37,
    glucoseNow: 90 + i * 6,
    meals,
    walks,
    // Every fourth case switches the meal clock off, as the CGMacros twin does.
    knobs: {
      ...knobs,
      carbSensitivity: 8 + (i % 5),
      ...(i % 4 === 3 ? { mealClock: false } : {}),
      ...(i % 3 === 1 ? { mealResidual: "scaled" as const } : {}),
    },
    band: { q10: -12 - (i % 4), q90: 14 + (i % 5) },
    horizonMin: i % 2 === 0 ? 120 : 60,
  };
  return { input, output: forecastCurve(input) };
});

const mealOffsetCases = Array.from({ length: 20 }, (_, i) => {
  const input = {
    delayMin: i * 9,
    carbs: 10 + i * 4,
    fiber: i % 7,
    sensPer10g: 4 + (i % 6),
    mealMin: 1440 * (i % 3) + ((5 * 60 + i * 67) % 1440),
  };
  return {
    input,
    output: mealOffset(input.delayMin, input.carbs, input.fiber, input.sensPer10g, input.mealMin),
  };
});

const walkOffsetCases = Array.from({ length: 20 }, (_, i) => {
  const input = { delayMin: i * 6, durationMin: 10 + (i % 5) * 10, effectPer30: 8 + i };
  return { input, output: walkOffset(input.delayMin, input.durationMin, input.effectPer30) };
});

const spikeProbabilityCases = Array.from({ length: 20 }, (_, i) => {
  const curve = forecastCurve({
    nowMin: 12 * 60,
    glucoseNow: 100 + i * 4,
    meals,
    walks: [],
    knobs,
    band: { q10: -16, q90: 18 },
  });
  return { input: { current: 100 + i * 4, points: curve }, output: spikeProbability(100 + i * 4, curve) };
});

const hygieneFiresCases = Array.from({ length: 20 }, (_, i) => {
  const samples = Array.from({ length: 16 }, (_, step) => ({
    spike: ((i + step) % 5) / 4,
    low: ((i + step * 2) % 7) / 6,
    gap: step === 4 && i % 3 === 0,
    day: step < 8 ? 0 : 1,
  }));
  return { input: { samples, suppressionSteps: 3, dailyCap: 4 }, output: hygieneFires(samples, 3, 4) };
});

const clarkeZoneCases = Array.from({ length: 20 }, (_, i) => {
  const pairs = [
    [90, 95],
    [60, 65],
    [200, 210],
    [50, 190],
    [200, 60],
    [100, 220],
    [150, 40],
    [80, 160],
    [250, 120],
    [40, 40],
    [120, 118],
    [70, 69],
    [180, 100],
    [300, 80],
    [110, 190],
    [95, 70],
    [160, 250],
    [55, 80],
    [220, 190],
    [75, 140],
  ] as const;
  const [reference, prediction] = pairs[i]!;
  return { input: { reference, prediction }, output: clarkeZone(reference, prediction) };
});

const findGlucoseEventsCases = Array.from({ length: 20 }, (_, i) => {
  const points = Array.from({ length: 80 }, (_, index) => ({
    glucose: 110 + (index % 17) - 8,
    blocked: false as boolean,
  }));
  points[30 + (i % 5)] = { glucose: 210, blocked: false };
  points[50] = { glucose: 62, blocked: i % 4 === 0 };
  if (i % 4 !== 0) points[50] = { glucose: 62, blocked: false };
  for (let k = 44; k < 50; k += 1) points[k] = { glucose: 100, blocked: false };
  if (i % 6 === 0) points[20] = { glucose: 40, blocked: true };
  const meals = [{ index: 10 + (i % 4), pre: i % 5 === 0 ? null : 100 }];
  return { input: { points, meals, stepMin: 5 }, output: findGlucoseEvents(points, meals, 5) };
});

const scoreAlertEventsCases = Array.from({ length: 20 }, (_, i) => {
  const spikes = [40 + i, 80];
  const lows = i % 2 === 0 ? [60] : [];
  const alerts = [
    { index: 40 + i - 8, kind: "spike" as const },
    { index: 10, kind: "spike" as const },
    { index: 55, kind: "low" as const },
  ];
  return { input: { spikes, lows, alerts, stepMin: 5 }, output: scoreAlertEvents(spikes, lows, alerts, 5) };
});

const night = (i: number) => ({
  sleepH: 4.5 + (i % 8) * 0.5,
  efficiency: i % 5 === 0 ? 0 : 0.72 + (i % 6) * 0.04,
  rmssd: i % 7 === 0 ? 0 : 30 + (i % 9) * 4,
});

const wearableSensitivityCases = Array.from({ length: 20 }, (_, i) => {
  const input = { night: night(i), rmssdBaseline: i % 4 === 0 ? 0 : 50, previous: i % 3 === 0 ? null : night(i + 3) };
  return { input, output: wearableSensitivity(input.night, input.rmssdBaseline, input.previous ?? undefined) };
});

const wearableDawnCases = Array.from({ length: 20 }, (_, i) => {
  const input = { night: night(i + 1), rmssdBaseline: 46, previous: i % 2 === 0 ? night(i + 5) : null };
  return { input, output: wearableDawn(input.night, input.rmssdBaseline, input.previous ?? undefined) };
});

const postWalkSensitivityCases = Array.from({ length: 20 }, (_, i) => {
  const input = {
    absMin: 18 * 60 + i * 95,
    walks: [
      { min: 18 * 60, durationMin: 10 + (i % 4) * 10 },
      { min: 26 * 60, durationMin: 20 },
    ],
  };
  return { input, output: postWalkSensitivity(input.absMin, input.walks) };
});

const lowProbabilityCases = Array.from({ length: 20 }, (_, i) => {
  const curve = forecastCurve({
    nowMin: 16 * 60 + i * 11,
    glucoseNow: 72 + i * 3,
    meals,
    walks: [{ min: 16 * 60 + i * 11 - 10, durationMin: 40 }],
    knobs: { ...knobs, fastingBaseline: 80 + (i % 5) * 4, activityEffect: 30 },
    band: { q10: -14, q90: 16 },
  });
  return { input: { current: 72 + i * 3, points: curve }, output: lowProbability(72 + i * 3, curve) };
});

const trendLowRiskCases = Array.from({ length: 20 }, (_, i) => {
  const input = {
    current: 70 + (i % 10) * 3,
    earlier: i % 9 === 0 ? null : 70 + (i % 10) * 3 + 10 + (i % 6) * 8,
    rule:
      i % 11 === 0
        ? null
        : {
            aheadMin: 15,
            fallRate: -1 - (i % 3) * 0.5,
            dampMin: 10 + (i % 2) * 10,
            blend: 0.5,
            ...(i % 4 === 1 ? { ceiling: 85, ceilingFasting: 92 } : i % 4 === 2 ? { ceiling: 92, ceilingFasting: 100 } : {}),
          },
    context: { twinTrough30: i % 4 === 0 ? null : 60 + (i % 7) * 5, minutesSinceMeal: i % 5 === 0 ? null : 30 + (i % 6) * 40 },
  };
  return { input, output: trendLowRisk(input.current, input.earlier, input.rule, input.context) };
});

const conformalBandCases = Array.from({ length: 20 }, (_, i) => {
  // 15 to 72 residuals: below 20 falls back to ±18, above exercises the finite-sample order statistics.
  const errors = Array.from({ length: 15 + i * 3 }, (_, k) => Math.sin(k * 1.7 + i) * (12 + i) + ((k * 7) % 11) - 5);
  return { input: { errors }, output: conformalBand(errors) };
});

const twinLowRiskCases = Array.from({ length: 20 }, (_, i) => {
  const curve = forecastCurve({
    nowMin: 18 * 60 + i * 20,
    glucoseNow: 80 + i * 2,
    meals: [{ min: 18 * 60 - 40, carbs: 45, fiber: 4, protein: 10, fat: 8, name: "dinner" }],
    walks: [],
    knobs: { ...knobs, fastingBaseline: 70 + (i % 5) * 4 },
    band: { q10: -14, q90: 14 },
    horizonMin: 60,
  });
  const input = {
    current: 80 + i * 2,
    points: curve,
    context: {
      minutesSinceMeal: i % 4 === 0 ? null : 30 + (i % 6) * 25,
      drugActive: i % 3 === 0,
      ...(i % 5 === 1 ? { postMealCeiling: null } : i % 5 === 2 ? { postMealCeiling: 100 } : {}),
    },
  };
  return { input, output: twinLowRisk(input.current, input.points, input.context) };
});

const payload = {
  conformalBand: conformalBandCases,
  twinLowRisk: twinLowRiskCases,
  wearableSensitivity: wearableSensitivityCases,
  wearableDawn: wearableDawnCases,
  postWalkSensitivity: postWalkSensitivityCases,
  lowProbability: lowProbabilityCases,
  trendLowRisk: trendLowRiskCases,
  forecastCurve: forecastCurveCases,
  mealOffset: mealOffsetCases,
  walkOffset: walkOffsetCases,
  spikeProbability: spikeProbabilityCases,
  hygieneFires: hygieneFiresCases,
  clarkeZone: clarkeZoneCases,
  findGlucoseEvents: findGlucoseEventsCases,
  scoreAlertEvents: scoreAlertEventsCases,
};

mkdirSync("ml/fixtures", { recursive: true });
writeFileSync("ml/fixtures/physics_cases.json", JSON.stringify(payload));
console.log("wrote ml/fixtures/physics_cases.json");
