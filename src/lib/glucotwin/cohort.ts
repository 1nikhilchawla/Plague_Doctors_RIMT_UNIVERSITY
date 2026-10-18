/**
 * Simulated 21-day cohort (seed 42). Physiology is a documented meal/walk/dawn
 * curve plus noise — not a CGMacros-trained model. Every metric is computed
 * from this series.
 */
import { describeItems, sumMacros, type PlateItem } from "./foods.ts";
import {
  STEP_MIN,
  activityWhenWorn,
  circadian,
  clarkeZone,
  clipGlucose,
  conformalBand,
  dawnRise,
  forecastCurve,
  findGlucoseEvents,
  gammaMealOffset,
  gmiFromMean,
  homaIr,
  hygieneFires,
  levelAt,
  mealClockMin,
  mealSizeFactor,
  mealTimeFactor,
  troughWithin,
  twinLowRisk,
  mealOffset,
  mismatchedWalkOffset,
  mulberry32,
  orderQuantiles,
  postWalkSensitivity,
  quantile,
  scoreAlertEvents,
  trendLowRisk,
  wearableDawn,
  wearableSensitivity,
  spikeProbability,
  peakOf,
  minutesAbove,
  walkOffset,
  type BandOffset,
  type CurvePoint,
  type LowTrendRule,
  type MacroEvent,
  type TwinKnobs,
  type WalkEvent,
} from "./physics.ts";
import { applyCluster, assignCluster, type ClusterId } from "./clusters.ts";
import { daySteps, sleepStages, type SleepStages } from "./wearable.ts";
import {
  driftWindows,
  globalKnobs,
  interpolatePricks,
  maskedRmse,
  prickClocks,
  seededEhrPrior,
  type Calibration,
} from "./ehr.ts";

export const ORIGIN_MS = Date.UTC(2026, 2, 1, 18, 30, 0);
export const DAYS = 21;
export const STEPS_PER_DAY = 1440 / STEP_MIN;
export const SERIES_LEN = DAYS * STEPS_PER_DAY;
const PARAM_DAYS = 5;
const CONF_START = 5;
const CONF_END = 9;
const EVAL_START = 9;

export type Group = "t2d" | "prediabetes" | "healthy";

export type Patient = {
  /** Day the record starts a sulfonylurea (simulated medication list), or null. */
  sulfonylureaFromDay?: number | null;
  id: string;
  name: string;
  age: number;
  sex: "F" | "M";
  group: Group;
  heightCm: number;
  weightKg: number;
  bmi: number;
  hba1c: number;
  hba1cHistory: { when: string; percent: number }[];
  fastingGlucose: number | null;
  fastingInsulin: number | null;
  homaIr: number | null;
  triglycerides: number | null;
  hdl: number | null;
  ldl: number | null;
  onMetformin: boolean;
  alleles: 0 | 1 | 2;
  diagnoses: string[];
  meds: string[];
  lagSteps: number;
  simulated: boolean;
  cluster: ClusterId;
  clusterNote: string;
};

export type Reading = {
  glucose: number | null;
  hr: number | null;
  mets: number | null;
  activityKcal: number | null;
  worn: boolean;
  cgmGap: boolean;
  cgmNoise: boolean;
  cgmCensored: boolean;
  compressionLow: boolean;
  cgmSource: "dexcom" | "gap";
};

export type Meal = MacroEvent & {
  id: string;
  logged: boolean;
  items: PlateItem[];
};

export type Walk = WalkEvent & { logged: boolean; mets: number };

export type Night = {
  dayIndex: number;
  durationH: number;
  efficiency: number;
  rmssd: number;
  short: boolean;
  simulated: boolean;
  stages?: SleepStages;
  steps?: number;
};

export type TwinParams = {
  carbSensitivity: number;
  activityEffect: number;
  fastingBaseline: number;
  recoveryMin: number | null;
  isolatedMeals: number;
  knobs: TwinKnobs;
  calibration: Calibration;
  /** How far the knobs moved from the prior toward the personal fit (0–1), chosen on validation days 6–9. */
  personalTrust: number;
  /** The prior the knobs shrink toward: the blended record + cluster prior, or the group prior when the record-based twin was not clearly better on validation days. */
  prior?: "record" | "group";
};

export type Reason = { group: string; text: string; magnitude: number };

export type Alert = {
  id: string;
  index: number;
  kind: "spike" | "low";
  probability: number;
  leadMin: number | null;
  cameTrue: boolean;
  reasons: Reason[];
  severity: "watch" | "urgent";
  /** Index at which the alert became Urgent: its own index when it fired Urgent, later when a Watch was upgraded. */
  urgentAt?: number;
};

export type HorizonScore = {
  horizonMin: 30 | 60 | 120;
  rmseTwin: number;
  rmsePersistence: number;
  rmsePopulation: number;
  improvementPct: number;
  mae: number;
  mard: number;
  coverage: number;
  clarkeApb: number | null;
  n: number;
  patientRmseMean: number;
  patientRmseCi: [number, number];
};

export type GroupScore = {
  group: Group;
  patients: number;
  rmse60: number;
  rmse60Persistence: number;
  improvementPct: number;
};

export type AlertScore = {
  spikeEvents: number;
  lowEvents: number;
  spikeAlerts: number;
  lowAlerts: number;
  spikeRecall: number | null;
  spikePrecision: number | null;
  lowRecall: number | null;
  lowPrecision: number | null;
  falsePerPatientDay: number;
  medianLeadMin: number | null;
  leadIqrMin: [number, number] | null;
  evalDays: number;
  spikeHits?: number;
  lowHits?: number;
  spikeTrue?: number;
  lowTrue?: number;
  urgentAlerts?: number;
  /** Urgent recall against clinically severe events (spike peak > 250 or ≥ 60 min > 180 within 3 h, and every low). */
  urgentRecall?: number | null;
  /** Severe events in the denominator of urgentRecall. */
  urgentEvents?: number;
  /** Urgent recall against every event, mild spikes included. */
  urgentRecallAllEvents?: number | null;
  urgentHitsAllEvents?: number;
  urgentPrecision?: number | null;
  urgentHits?: number;
  urgentTrue?: number;
  watchAlerts?: number;
  urgentPerPatientDay?: number;
  watchPerPatientDay?: number;
};

export type AblationArm = {
  id: string;
  label: string;
  rmse60: number;
  n: number;
  /** Alerts rebuilt for this arm (its knobs, stream mask and medicine), scored on days 10–21. */
  alerts?: ArmAlertScore;
};

export type ArmAlertScore = {
  spikeF1: number | null;
  lowHits: number;
  lowEvents: number;
  lowRecall: number | null;
  urgentHits: number;
  urgentEvents: number;
  urgentRecall: number | null;
};

export type CohortEval = {
  horizons: HorizonScore[];
  groups: GroupScore[];
  alerts: AlertScore;
  generator: "matched" | "mismatched";
};

/**
 * Real data only: the leave-one-participant-out trend correction
 * (p50 += slopeGain · slope30 · minutes ahead + bias, interpolated between
 * 30, 60 and 120 min) and the conformal band refit after it.
 */
export type TrendCorrection = {
  coef: Record<30 | 60 | 120, { slopeGain: number; bias: number }>;
  bands: Record<30 | 60 | 120, BandOffset>;
};

export type AlertSetup = {
  readyAt: number;
  lowScale: number;
  spikeScale: number;
  lowTrend: LowTrendRule | null;
};

export type StreamConsent = { ehr: boolean; wearable: boolean };

export type PatientModel = {
  patient: Patient;
  readings: Reading[];
  meals: Meal[];
  walks: Walk[];
  nights: Night[];
  params: TwinParams;
  popKnobs: TwinKnobs;
  bands: Record<30 | 60 | 120, BandOffset>;
  alerts: Alert[];
  spikeProb: Float32Array;
  lowProb: Float32Array;
  active: Uint8Array;
  fit: { rmse60: number; rmse60Pop: number; rmse120: number };
  originMs: number;
  libreOffset: number | null;
  /** Record-informed prior (labs, cluster) the live twin shrinks toward. */
  ehrKnobs: TwinKnobs;
  /** The same personal CGM fit shrunk toward the group prior instead: the twin without the record. */
  noRecordKnobs: TwinKnobs;
  trend?: TrendCorrection;
  /** How the alerts were built, so consentModel can rebuild them on fewer streams. */
  alertSetup: AlertSetup;
  /** Set on the view consentModel returns: the full-stream model and the consent applied. */
  consentOf?: { base: PatientModel; consent: StreamConsent };
  driftStart: number | null;
  driftRecovered: number | null;
};

export type Cue = {
  id: string;
  label: string;
  patientId: string;
  index: number;
  tab?: "twin" | "split" | "night";
};

export type Cohort = {
  patients: PatientModel[];
  demoIndex: number;
  cues: Cue[];
  trainingMaxCarbs: number;
  eval: CohortEval;
  evalMatched: CohortEval;
  ablation: AblationArm[];
  streamAblation: AblationArm[];
  lowCost: { pricks: number; rmse: number }[];
  habitLeadMin: number | null;
  habitRecall: number | null;
  /** Meal-scaled vs plain residual, pooled 60-min RMSE on validation days 6–9; the ward uses `chosen`. */
  mealResidual: { chosen: "plain" | "scaled"; validationRmse60: { plain: number; scaled: number } };
  generator: "mismatched";
  originMs: number;
  seriesLength: number;
};

export type WhatIfEdit = {
  meal?:
    | { inMin: number; items: PlateItem[] }
    | { inMin: number; carbs: number; fiber: number; protein: number; fat: number; name: string }
    | null;
  walk?: { inMin: number; durationMin: number } | null;
  sleepHours?: number | null;
  /** Recompute the residual as if unlogged snacks up to now had been logged. */
  includeUnlogged?: boolean;
  /** Stream consent. A revoked record falls back to the group prior; revoked wearables drop sleep, HRV and walks. Both widen the band. */
  consent?: { ehr: boolean; wearable: boolean };
  horizonMin?: number;
};

export type TraceContributor = {
  id: string;
  kind: "circadian" | "meal" | "walk" | "residual" | "unlogged";
  label: string;
  detail: string;
  mgdl: number;
};

export type StreamMarks = {
  gapMin: number;
  compressionMin: number;
  offWristMin: number;
  sharpJumps: number;
};

export type TraceNow = {
  blocked: null | "gap" | "compression" | "missing";
  glucose: number | null;
  contributors: TraceContributor[];
  unlogged: TraceContributor[];
  recent: StreamMarks;
  today: StreamMarks;
  tauMin: number;
  dawnMgdl: number;
  sleepHours: number;
  sleepScale: number;
};

type Persona = {
  id: string;
  name: string;
  age: number;
  sex: "F" | "M";
  group: Group;
  heightCm: number;
  weightKg: number;
  hba1c: number;
  history: number[];
  fastingGlucose: number;
  fastingInsulin: number;
  triglycerides: number;
  hdl: number;
  ldl: number;
  alleles: 0 | 1 | 2;
  lagSteps: number;
  true: TwinKnobs;
  noise: number;
  seed: number;
  breakfast: PlateItem[];
  lunch: PlateItem[];
  dinner: PlateItem[];
  breakfastMin: number;
  lunchMin: number;
  dinnerMin: number;
  walkMinute: number;
  walkDuration: number;
  walkDays: (day: number) => boolean;
  snackDays: (day: number) => boolean;
  snack: PlateItem[];
  snackMin: number;
  lightDinnerDays?: (day: number) => boolean;
  lightDinner?: PlateItem[];
  gap?: { day: number; from: number; to: number };
  nonwear?: { day: number; from: number; to: number };
  compression?: { day: number; from: number; to: number };
  noiseJump?: { day: number; minute: number };
  /** Day index when a simulated sulfonylurea starts. Modelling assumption. */
  drugFromDay?: number;
  /** Multiplier on generator carb sensitivity from that day. 0.7 is a 30% cut. */
  drugCarbFactor?: number;
  skipDinnerFromDay?: number;
};

export const POP: Record<Group, TwinKnobs> = {
  t2d: { carbSensitivity: 12, activityEffect: 14, fastingBaseline: 140, dawnAmp: 22, tauMin: 150 },
  prediabetes: {
    carbSensitivity: 7.2,
    activityEffect: 18,
    fastingBaseline: 106,
    dawnAmp: 8,
    tauMin: 100,
  },
  healthy: {
    carbSensitivity: 4.4,
    activityEffect: 20,
    fastingBaseline: 92,
    dawnAmp: 3,
    tauMin: 70,
  },
};

const HISTORY_WHEN = ["May 2025", "Aug 2025", "Nov 2025", "Feb 2026"];

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function bmiOf(heightCm: number, weightKg: number): number {
  const m = heightCm / 100;
  return round1(weightKg / (m * m));
}

function scaleFor(seed: number, day: number, slot: number): number {
  return 0.9 + ((seed * 13 + day * 7 + slot * 3) % 11) * 0.02;
}

function inWindow(minute: number, from: number, to: number): boolean {
  return minute >= from && minute < to;
}

function personas(): Persona[] {
  const walkEvery = (day: number) => day >= 0 && day % 1 === 0;
  return [
    {
      id: "GT-07",
      name: "Ananya Rao",
      age: 54,
      sex: "F",
      group: "t2d",
      heightCm: 158,
      weightKg: 73.4,
      hba1c: 8.1,
      history: [7.4, 7.6, 7.9, 8.1],
      fastingGlucose: 152,
      fastingInsulin: 16.4,
      triglycerides: 186,
      hdl: 42,
      ldl: 128,
      alleles: 2,
      lagSteps: 0,
      true: {
        carbSensitivity: 13.5,
        activityEffect: 12,
        fastingBaseline: 146,
        dawnAmp: 24,
        tauMin: 150,
      },
      noise: 4.2,
      seed: 7,
      breakfast: [
        { foodId: "atta", servings: 1.5 },
        { foodId: "toor", servings: 1 },
      ],
      lunch: [
        { foodId: "rice", servings: 2 },
        { foodId: "potato", servings: 1 },
        { foodId: "ghee", servings: 1 },
      ],
      dinner: [
        { foodId: "atta", servings: 2 },
        { foodId: "spinach", servings: 1 },
      ],
      breakfastMin: 8 * 60,
      lunchMin: 13 * 60,
      dinnerMin: 20 * 60,
      walkMinute: 18 * 60 + 30,
      walkDuration: 25,
      walkDays: (day) => day % 2 === 0,
      snackDays: (day) => day % 2 === 1 && day % 5 !== 0,
      snack: [{ foodId: "banana", servings: 0.6 }],
      snackMin: 16 * 60 + 30,
      compression: { day: 2, from: 2 * 60, to: 2 * 60 + 30 },
    },
    {
      id: "GT-12",
      name: "Vikram Shah",
      age: 61,
      sex: "M",
      group: "t2d",
      heightCm: 172,
      weightKg: 79,
      hba1c: 7.4,
      history: [7.1, 7.2, 7.3, 7.4],
      fastingGlucose: 138,
      fastingInsulin: 12,
      triglycerides: 160,
      hdl: 40,
      ldl: 118,
      alleles: 1,
      lagSteps: 0,
      true: {
        carbSensitivity: 10,
        activityEffect: 16,
        fastingBaseline: 134,
        dawnAmp: 18,
        tauMin: 140,
      },
      noise: 4,
      seed: 12,
      breakfast: [
        { foodId: "rava", servings: 1.5 },
        { foodId: "oil-sun", servings: 1 },
      ],
      lunch: [
        { foodId: "rice", servings: 1.5 },
        { foodId: "toor", servings: 1 },
        { foodId: "ghee", servings: 1 },
      ],
      dinner: [
        { foodId: "atta", servings: 2 },
        { foodId: "chicken", servings: 1 },
      ],
      breakfastMin: 8 * 60 + 15,
      lunchMin: 13 * 60 + 10,
      dinnerMin: 20 * 60 + 15,
      walkMinute: 7 * 60,
      walkDuration: 30,
      walkDays: (day) => day % 2 === 1,
      snackDays: (day) => day % 7 === 2,
      snack: [{ foodId: "murmura", servings: 1 }],
      snackMin: 16 * 60,
      gap: { day: 4, from: 11 * 60, to: 11 * 60 + 40 },
    },
    {
      id: "GT-03",
      name: "Kavita Deshmukh",
      age: 66,
      sex: "F",
      group: "t2d",
      heightCm: 154,
      weightKg: 62,
      hba1c: 7.2,
      history: [7.6, 7.4, 7.3, 7.2],
      fastingGlucose: 118,
      fastingInsulin: 9,
      triglycerides: 142,
      hdl: 48,
      ldl: 110,
      alleles: 1,
      lagSteps: 0,
      true: {
        carbSensitivity: 12,
        activityEffect: 58,
        fastingBaseline: 108,
        dawnAmp: 12,
        tauMin: 110,
      },
      noise: 3.6,
      seed: 3,
      breakfast: [
        { foodId: "rava", servings: 1.2 },
        { foodId: "oil-must", servings: 1 },
      ],
      lunch: [
        { foodId: "rice", servings: 2 },
        { foodId: "toor", servings: 1 },
      ],
      dinner: [
        { foodId: "atta", servings: 1 },
        { foodId: "spinach", servings: 1 },
      ],
      breakfastMin: 8 * 60,
      lunchMin: 13 * 60,
      dinnerMin: 19 * 60 + 30,
      walkMinute: 20 * 60 + 40,
      walkDuration: 40,
      walkDays: (day) => day % 2 === 0,
      snackDays: () => false,
      snack: [],
      snackMin: 16 * 60,
      lightDinnerDays: (day) => day % 2 === 0,
      lightDinner: [
        { foodId: "spinach", servings: 1 },
        { foodId: "tomato", servings: 1 },
      ],
    },
    {
      id: "GT-19",
      name: "Fatima Khan",
      age: 44,
      sex: "F",
      group: "t2d",
      heightCm: 160,
      weightKg: 78,
      hba1c: 9,
      history: [8.2, 8.5, 8.8, 9],
      fastingGlucose: 168,
      fastingInsulin: 18,
      triglycerides: 210,
      hdl: 38,
      ldl: 142,
      alleles: 2,
      lagSteps: 0,
      true: {
        carbSensitivity: 15.5,
        activityEffect: 10,
        fastingBaseline: 158,
        dawnAmp: 28,
        tauMin: 160,
      },
      noise: 4.8,
      seed: 19,
      breakfast: [
        { foodId: "atta", servings: 2 },
        { foodId: "egg", servings: 1 },
      ],
      lunch: [
        { foodId: "rice", servings: 1.5 },
        { foodId: "rajma", servings: 2 },
        { foodId: "oil-gn", servings: 1 },
      ],
      dinner: [
        { foodId: "rice", servings: 2 },
        { foodId: "potato", servings: 1 },
        { foodId: "ghee", servings: 1 },
      ],
      breakfastMin: 8 * 60 + 30,
      lunchMin: 13 * 60 + 20,
      dinnerMin: 20 * 60 + 30,
      walkMinute: 18 * 60,
      walkDuration: 20,
      walkDays: (day) => day === 6 || day === 13,
      snackDays: (day) => day % 3 !== 0,
      snack: [{ foodId: "dates", servings: 1 }],
      snackMin: 17 * 60,
      nonwear: { day: 6, from: 15 * 60, to: 16 * 60 },
    },
    {
      id: "GT-21",
      name: "Suresh Patel",
      age: 58,
      sex: "M",
      group: "t2d",
      heightCm: 168,
      weightKg: 82,
      hba1c: 8.4,
      history: [7.8, 8.0, 8.2, 8.4],
      fastingGlucose: 156,
      fastingInsulin: 15,
      triglycerides: 198,
      hdl: 36,
      ldl: 136,
      alleles: 2,
      lagSteps: 9,
      true: {
        carbSensitivity: 13,
        activityEffect: 11,
        fastingBaseline: 148,
        dawnAmp: 26,
        tauMin: 155,
      },
      noise: 4.4,
      seed: 21,
      breakfast: [
        { foodId: "poha", servings: 1.5 },
        { foodId: "groundnut", servings: 1 },
        { foodId: "oil-must", servings: 1 },
      ],
      lunch: [
        { foodId: "rice", servings: 2 },
        { foodId: "chana-dal", servings: 1 },
        { foodId: "ghee", servings: 1 },
      ],
      dinner: [
        { foodId: "atta", servings: 2 },
        { foodId: "cauli", servings: 1 },
      ],
      breakfastMin: 8 * 60 + 10,
      lunchMin: 13 * 60,
      dinnerMin: 20 * 60 + 10,
      walkMinute: 18 * 60 + 15,
      walkDuration: 20,
      walkDays: (day) => day % 3 === 0,
      snackDays: (day) => day % 4 === 1,
      snack: [{ foodId: "banana", servings: 0.5 }],
      snackMin: 16 * 60 + 45,
    },
    {
      id: "GT-05",
      name: "Meera Iyer",
      age: 47,
      sex: "F",
      group: "prediabetes",
      heightCm: 162,
      weightKg: 68,
      hba1c: 6.1,
      history: [5.8, 5.9, 6.0, 6.1],
      fastingGlucose: 108,
      fastingInsulin: 10,
      triglycerides: 140,
      hdl: 50,
      ldl: 112,
      alleles: 1,
      lagSteps: 0,
      true: {
        carbSensitivity: 7.2,
        activityEffect: 18,
        fastingBaseline: 106,
        dawnAmp: 10,
        tauMin: 100,
      },
      noise: 3.4,
      seed: 5,
      breakfast: [
        { foodId: "rava", servings: 1.2 },
        { foodId: "oil-sun", servings: 1 },
      ],
      lunch: [
        { foodId: "rice", servings: 1.5 },
        { foodId: "toor", servings: 1 },
      ],
      dinner: [
        { foodId: "atta", servings: 2 },
        { foodId: "spinach", servings: 1 },
      ],
      breakfastMin: 7 * 60 + 45,
      lunchMin: 13 * 60,
      dinnerMin: 20 * 60,
      walkMinute: 7 * 60,
      walkDuration: 30,
      walkDays: (day) => day % 3 !== 1,
      snackDays: (day) => day % 6 === 4,
      snack: [{ foodId: "murmura", servings: 0.8 }],
      snackMin: 16 * 60 + 30,
    },
    {
      id: "GT-28",
      name: "Arjun Nair",
      age: 38,
      sex: "M",
      group: "prediabetes",
      heightCm: 175,
      weightKg: 76,
      hba1c: 5.9,
      history: [5.7, 5.8, 5.8, 5.9],
      fastingGlucose: 102,
      fastingInsulin: 8,
      triglycerides: 120,
      hdl: 46,
      ldl: 108,
      alleles: 0,
      lagSteps: 0,
      true: {
        carbSensitivity: 6.4,
        activityEffect: 14,
        fastingBaseline: 100,
        dawnAmp: 6,
        tauMin: 90,
      },
      noise: 3.2,
      seed: 28,
      breakfast: [
        { foodId: "poha", servings: 1 },
        { foodId: "onion", servings: 0.5 },
      ],
      lunch: [
        { foodId: "atta", servings: 2 },
        { foodId: "chole", servings: 1.5 },
      ],
      dinner: [
        { foodId: "rice", servings: 1 },
        { foodId: "chicken", servings: 1 },
      ],
      breakfastMin: 7 * 60 + 30,
      lunchMin: 12 * 60 + 45,
      dinnerMin: 19 * 60 + 45,
      walkMinute: 18 * 60,
      walkDuration: 30,
      walkDays: walkEvery,
      snackDays: () => false,
      snack: [],
      snackMin: 16 * 60,
    },
    {
      id: "GT-02",
      name: "Rohan Gupta",
      age: 29,
      sex: "M",
      group: "healthy",
      heightCm: 178,
      weightKg: 72,
      hba1c: 5.2,
      history: [5.2, 5.1, 5.2, 5.2],
      fastingGlucose: 88,
      fastingInsulin: 6.2,
      triglycerides: 90,
      hdl: 54,
      ldl: 96,
      alleles: 0,
      lagSteps: 0,
      true: {
        carbSensitivity: 4.2,
        activityEffect: 12,
        fastingBaseline: 90,
        dawnAmp: 3,
        tauMin: 65,
      },
      noise: 2.8,
      seed: 2,
      breakfast: [
        { foodId: "rava", servings: 1 },
        { foodId: "banana", servings: 0.5 },
      ],
      lunch: [
        { foodId: "rice", servings: 1.5 },
        { foodId: "moong", servings: 1 },
      ],
      dinner: [
        { foodId: "atta", servings: 2 },
        { foodId: "chicken", servings: 1 },
      ],
      breakfastMin: 8 * 60,
      lunchMin: 13 * 60,
      dinnerMin: 20 * 60,
      walkMinute: 17 * 60 + 30,
      walkDuration: 30,
      walkDays: (day) => day % 5 !== 0,
      snackDays: (day) => day % 8 === 3,
      snack: [{ foodId: "apple", servings: 1 }],
      snackMin: 16 * 60,
      noiseJump: { day: 8, minute: 10 * 60 },
    },
    {
      id: "GT-31",
      name: "Divya Menon",
      age: 42,
      sex: "F",
      group: "t2d",
      heightCm: 160,
      weightKg: 54,
      hba1c: 9.2,
      history: [8.4, 8.7, 9.0, 9.2],
      fastingGlucose: 176,
      fastingInsulin: 5.5,
      triglycerides: 128,
      hdl: 46,
      ldl: 118,
      alleles: 1,
      lagSteps: 0,
      true: {
        carbSensitivity: 16,
        activityEffect: 12,
        fastingBaseline: 108,
        dawnAmp: 20,
        tauMin: 140,
      },
      noise: 3.8,
      seed: 31,
      drugFromDay: 15,
      drugCarbFactor: 0.7,
      skipDinnerFromDay: 15,
      breakfast: [
        { foodId: "atta", servings: 1.5 },
        { foodId: "toor", servings: 1 },
      ],
      lunch: [
        { foodId: "rice", servings: 1.5 },
        { foodId: "toor", servings: 1 },
      ],
      dinner: [
        { foodId: "atta", servings: 1.5 },
        { foodId: "spinach", servings: 1 },
      ],
      breakfastMin: 8 * 60,
      lunchMin: 13 * 60,
      dinnerMin: 20 * 60,
      walkMinute: 18 * 60,
      walkDuration: 20,
      walkDays: (day) => day % 3 === 0,
      snackDays: () => false,
      snack: [],
      snackMin: 16 * 60,
    },
    {
      id: "GT-33",
      name: "Imran Qureshi",
      age: 36,
      sex: "M",
      group: "t2d",
      heightCm: 170,
      weightKg: 60,
      hba1c: 8.9,
      history: [8.1, 8.4, 8.6, 8.9],
      fastingGlucose: 164,
      fastingInsulin: 5,
      triglycerides: 140,
      hdl: 42,
      ldl: 124,
      alleles: 1,
      lagSteps: 0,
      true: {
        carbSensitivity: 15,
        activityEffect: 14,
        fastingBaseline: 112,
        dawnAmp: 18,
        tauMin: 135,
      },
      noise: 3.6,
      seed: 33,
      breakfast: [
        { foodId: "poha", servings: 1 },
        { foodId: "egg", servings: 1 },
      ],
      lunch: [
        { foodId: "atta", servings: 2 },
        { foodId: "chana-dal", servings: 1 },
      ],
      dinner: [
        { foodId: "rice", servings: 1 },
        { foodId: "chicken", servings: 1 },
      ],
      breakfastMin: 8 * 60,
      lunchMin: 13 * 60,
      dinnerMin: 20 * 60,
      walkMinute: 7 * 60 + 15,
      walkDuration: 25,
      walkDays: (day) => day % 2 === 0,
      snackDays: () => false,
      snack: [],
      snackMin: 16 * 60,
    },
    {
      id: "GT-36",
      name: "Leela Joshi",
      age: 52,
      sex: "F",
      group: "t2d",
      heightCm: 156,
      weightKg: 74,
      hba1c: 9.6,
      history: [8.6, 9.0, 9.3, 9.6],
      fastingGlucose: 188,
      fastingInsulin: 20,
      triglycerides: 240,
      hdl: 34,
      ldl: 148,
      alleles: 2,
      lagSteps: 0,
      true: {
        carbSensitivity: 17,
        activityEffect: 9,
        fastingBaseline: 162,
        dawnAmp: 30,
        tauMin: 170,
      },
      noise: 4.6,
      seed: 36,
      breakfast: [
        { foodId: "atta", servings: 2 },
        { foodId: "ghee", servings: 1 },
      ],
      lunch: [
        { foodId: "rice", servings: 2 },
        { foodId: "rajma", servings: 2 },
      ],
      dinner: [
        { foodId: "rice", servings: 1.5 },
        { foodId: "potato", servings: 1 },
        { foodId: "ghee", servings: 1 },
      ],
      breakfastMin: 8 * 60 + 20,
      lunchMin: 13 * 60 + 15,
      dinnerMin: 20 * 60 + 20,
      walkMinute: 18 * 60 + 40,
      walkDuration: 15,
      walkDays: (day) => day % 4 === 0,
      snackDays: (day) => day % 2 === 0,
      snack: [{ foodId: "banana", servings: 0.5 }],
      snackMin: 17 * 60,
    },
  ];
}

function mealFrom(
  persona: Persona,
  day: number,
  minute: number,
  items: PlateItem[],
  slot: number,
  logged: boolean,
): Meal {
  const scaled = sumMacros(items);
  if (scaled.unresolved.length) {
    throw new Error(`Unresolved foods: ${scaled.unresolved.join(", ")}`);
  }
  const factor = scaleFor(persona.seed, day, slot);
  return {
    id: `${persona.id}-d${day}-s${slot}`,
    min: day * 1440 + minute,
    carbs: round2(scaled.macros.carbs * factor),
    fiber: round2(scaled.macros.fiber * factor),
    protein: round2(scaled.macros.protein * factor),
    fat: round2(scaled.macros.fat * factor),
    name: describeItems(items),
    logged,
    items,
  };
}

function buildSchedule(persona: Persona): { meals: Meal[]; walks: Walk[]; nights: Night[] } {
  const meals: Meal[] = [];
  const walks: Walk[] = [];
  const nights: Night[] = [];
  const resting = 62 + (persona.age - 40) * 0.25;
  const sleepRand = mulberry32(7000 + persona.seed * 131);
  for (let day = 0; day < DAYS; day += 1) {
    // Nights vary like a real wearable week: days 3 and 10 stay short for the
    // demo cues; one night in five is an HRV stress night with normal length.
    const forcedShort = day === 3 || day === 10;
    const jitter = sleepRand() - 0.5;
    const durationH = forcedShort
      ? 5
      : Math.round(
          Math.min(8.6, Math.max(4.8, 7.2 + (persona.seed % 4) * 0.2 + jitter * 2.4)) * 10,
        ) / 10;
    const short = durationH < 6;
    const stressed = !forcedShort && sleepRand() < 0.2;
    const debt = Math.max(0, 7 - durationH);
    const efficiency =
      Math.round(Math.min(0.96, Math.max(0.7, 0.93 - 0.045 * debt - sleepRand() * 0.06)) * 100) /
      100;
    const rmssd = Math.max(
      12,
      Math.round(
        (58 - (resting - 60) - 4 * debt + (sleepRand() - 0.5) * 6) * (stressed ? 0.72 : 1),
      ),
    );
    const walkMin = persona.walkDays(day) ? persona.walkDuration : 0;
    nights.push({
      dayIndex: day,
      durationH,
      efficiency,
      rmssd,
      short,
      simulated: true,
      stages: sleepStages(durationH, short),
      steps: daySteps(walkMin, persona.seed, day),
    });
    meals.push(mealFrom(persona, day, persona.breakfastMin, persona.breakfast, 0, true));
    meals.push(mealFrom(persona, day, persona.lunchMin, persona.lunch, 1, true));
    const skipDinner = persona.skipDinnerFromDay != null && day >= persona.skipDinnerFromDay;
    if (!skipDinner) {
      const light = persona.lightDinnerDays?.(day) && persona.lightDinner;
      meals.push(
        mealFrom(
          persona,
          day,
          persona.dinnerMin,
          light ? persona.lightDinner! : persona.dinner,
          2,
          true,
        ),
      );
    }
    if (persona.snackDays(day) && persona.snack.length) {
      meals.push(mealFrom(persona, day, persona.snackMin, persona.snack, 3, false));
    }
    if (persona.walkDays(day)) {
      walks.push({
        min: day * 1440 + persona.walkMinute,
        durationMin: persona.walkDuration,
        logged: true,
        mets: 4.4,
      });
    }
  }
  meals.sort((a, b) => a.min - b.min);
  return { meals, walks, nights };
}

function drugEffect(
  persona: Persona,
  absMin: number,
  meals: MacroEvent[],
  carb: number,
): { carb: number; offset: number } {
  const day = Math.floor(absMin / 1440);
  if (persona.drugFromDay == null || day < persona.drugFromDay) return { carb, offset: 0 };
  const minute = absMin % 1440;
  let last = -1_000_000;
  for (const meal of meals) {
    if (meal.min <= absMin && meal.min > last) last = meal.min;
  }
  const gap = absMin - last;
  let offset = 0;
  if (minute >= 15 * 60 && minute < 23 * 60 && gap >= 240) offset = -55;
  else if ((minute >= 23 * 60 || minute < 6 * 60) && gap >= 360) offset = -40;
  return { carb: carb * (persona.drugCarbFactor ?? 1), offset };
}

/** Spikes and lows of a patient's CGM stream, using the logged meals as rise anchors. */
function glucoseEventsOf(model: PatientModel): ReturnType<typeof findGlucoseEvents> {
  const points = model.readings.map((reading) => ({
    glucose: reading?.glucose ?? null,
    blocked: !reading || reading.glucose == null || reading.cgmGap || reading.compressionLow,
  }));
  const meals = model.meals
    .filter((meal) => meal.logged)
    .map((meal) => {
      const index = Math.round(meal.min / STEP_MIN);
      return { index, pre: glucoseAt(model.readings, index) };
    });
  return findGlucoseEvents(points, meals, STEP_MIN);
}

function glucoseAt(readings: Reading[], index: number): number | null {
  const reading = readings[index];
  if (!reading || reading.cgmGap || reading.compressionLow) return null;
  return reading.glucose;
}

function simulate(
  persona: Persona,
  meals: MacroEvent[],
  walks: Walk[],
  nights: Night[],
): Reading[] {
  const rand = mulberry32(42 + persona.seed * 997);
  const normal = () => {
    const u = Math.max(1e-9, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const readings: Reading[] = [];
  let noise = 0;
  const resting = 62 + (persona.age - 40) * 0.25;
  for (let index = 0; index < SERIES_LEN; index += 1) {
    const absMin = index * STEP_MIN;
    const day = Math.floor(absMin / 1440);
    const minute = absMin % 1440;
    const wearNight = nightOf(nights, day);
    const wearPrev = prevNightOf(nights, day);
    const hrvBase = hrvBaseline(nights);
    const drug = drugEffect(
      persona,
      absMin,
      meals,
      persona.true.carbSensitivity *
        wearableSensitivity(wearNight, hrvBase, wearPrev) *
        postWalkSensitivity(absMin, walks),
    );
    const knobs: TwinKnobs = {
      ...persona.true,
      carbSensitivity: drug.carb,
      dawnAmp: persona.true.dawnAmp * wearableDawn(wearNight, hrvBase, wearPrev),
    };
    const expected = levelAt(absMin, meals, walks, knobs) + drug.offset;
    noise = 0.82 * noise + normal() * persona.noise * 0.55;
    let raw = expected + noise;
    let compressionLow = false;
    if (
      persona.compression &&
      persona.compression.day === day &&
      inWindow(minute, persona.compression.from, persona.compression.to)
    ) {
      const span = persona.compression.to - persona.compression.from;
      const phase = (minute - persona.compression.from) / span;
      const dip = Math.sin(Math.PI * phase);
      raw = persona.true.fastingBaseline - 78 * dip;
      compressionLow = true;
    }
    if (persona.noiseJump && persona.noiseJump.day === day && minute === persona.noiseJump.minute) {
      raw = (readings[index - 1]?.glucose ?? raw) + 28;
    }
    const cgmCensored = raw <= 40 || raw >= 400;
    const glucose = clipGlucose(raw);
    const gap = Boolean(
      persona.gap && persona.gap.day === day && inWindow(minute, persona.gap.from, persona.gap.to),
    );
    const worn = !(
      persona.nonwear &&
      persona.nonwear.day === day &&
      inWindow(minute, persona.nonwear.from, persona.nonwear.to)
    );
    const walking = walks.some(
      (walk) => absMin >= walk.min && absMin < walk.min + walk.durationMin,
    );
    const mets = walking ? 4.4 : 1.15 + (rand() - 0.5) * 0.1;
    const hr = walking ? resting + 48 + rand() * 6 : resting + (rand() - 0.5) * 4;
    const kcal = ((mets * 3.5 * persona.weightKg) / 200) * STEP_MIN;
    const prev = readings[index - 1]?.glucose;
    const cgmNoise = !compressionLow && prev != null && Math.abs(glucose - prev) > 4 * STEP_MIN;
    readings.push({
      glucose: gap ? null : glucose,
      hr: worn ? Math.round(hr) : null,
      mets: worn ? round2(mets) : null,
      activityKcal: activityWhenWorn(worn, round2(kcal)),
      worn,
      cgmGap: gap,
      cgmNoise,
      cgmCensored: !gap && cgmCensored,
      compressionLow: !gap && compressionLow,
      cgmSource: gap ? "gap" : "dexcom",
    });
  }
  return readings;
}

/** Stress-test response to sleep and HRV. A different shape and size from the twin's wearableSensitivity. */
function mismatchedWearable(
  night: { sleepH: number; efficiency: number; rmssd: number },
  rmssdBase: number,
  previous?: { sleepH: number; efficiency: number; rmssd: number },
): { sens: number; dawn: number } {
  const load = (n: { sleepH: number; efficiency: number; rmssd: number }) => ({
    debt: Math.min(4, Math.max(0, 7.2 - n.sleepH)),
    poorEff: n.efficiency > 0 ? Math.min(0.3, Math.max(0, 0.91 - n.efficiency)) : 0,
    hrvDrop:
      n.rmssd > 0 && rmssdBase > 0
        ? Math.min(0.5, Math.max(0, (rmssdBase - n.rmssd) / rmssdBase))
        : 0,
  });
  const now = load(night);
  const before = previous ? load(previous) : { debt: 0, poorEff: 0, hrvDrop: 0 };
  // Carry-over is 0.6 here and 0.5 in the twin; the curve is quadratic in debt.
  const debt = now.debt + 0.6 * before.debt;
  const poorEff = now.poorEff + 0.6 * before.poorEff;
  const hrvDrop = now.hrvDrop + 0.6 * before.hrvDrop;
  return {
    sens: 1 + 0.05 * debt + 0.015 * debt * debt + 0.3 * poorEff + 0.5 * hrvDrop,
    dawn: 1 + 0.16 * debt + 0.4 * hrvDrop,
  };
}

function mismatchedLevel(
  absMin: number,
  meals: MacroEvent[],
  walks: Walk[],
  knobs: TwinKnobs,
): number {
  let total = circadian(absMin, knobs.dawnAmp, knobs.fastingBaseline);
  for (const meal of meals) {
    total += gammaMealOffset(
      absMin - meal.min,
      meal.carbs,
      meal.fiber,
      meal.fat,
      meal.protein,
      knobs.carbSensitivity,
      meal.min,
    );
  }
  for (const walk of walks) {
    total += mismatchedWalkOffset(absMin - walk.min, walk.durationMin, knobs.activityEffect);
  }
  return total;
}

/** Stress-test stream. The twin never calls this curve. */
function simulateMismatched(
  persona: Persona,
  meals: MacroEvent[],
  walks: Walk[],
  nights: Night[],
): Reading[] {
  const rand = mulberry32(42 + persona.seed * 997 + 17);
  const normal = () => {
    const u = Math.max(1e-9, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const daySens: number[] = [];
  let sens = 1;
  for (let day = 0; day < DAYS; day += 1) {
    sens = Math.min(1.15, Math.max(0.85, sens + (rand() - 0.5) * 0.08));
    daySens.push(sens);
  }
  const truth: number[] = [];
  let noise = 0;
  for (let index = 0; index < SERIES_LEN; index += 1) {
    const absMin = index * STEP_MIN;
    const day = Math.floor(absMin / 1440);
    const minute = absMin % 1440;
    const wear = mismatchedWearable(
      nightOf(nights, day),
      hrvBaseline(nights),
      prevNightOf(nights, day),
    );
    const drug = drugEffect(
      persona,
      absMin,
      meals,
      persona.true.carbSensitivity * wear.sens * daySens[day]! * postWalkSensitivity(absMin, walks),
    );
    const knobs: TwinKnobs = {
      ...persona.true,
      carbSensitivity: drug.carb,
      dawnAmp: persona.true.dawnAmp * wear.dawn,
    };
    let raw = mismatchedLevel(absMin, meals, walks, knobs) + drug.offset;
    noise = 0.78 * noise + normal() * persona.noise * 0.7;
    raw += noise;
    if (
      persona.compression &&
      persona.compression.day === day &&
      inWindow(minute, persona.compression.from, persona.compression.to)
    ) {
      const span = persona.compression.to - persona.compression.from;
      const phase = (minute - persona.compression.from) / span;
      raw = persona.true.fastingBaseline - 78 * Math.sin(Math.PI * phase);
    }
    if (persona.noiseJump && persona.noiseJump.day === day && minute === persona.noiseJump.minute) {
      raw = (truth[index - 1] ?? raw) + 28;
    }
    truth.push(raw);
  }
  const lag = persona.seed % 2 === 0 ? 1 : 2;
  let calib = 1;
  let dropout = 0;
  const readings: Reading[] = [];
  const resting = 62 + (persona.age - 40) * 0.25;
  for (let index = 0; index < SERIES_LEN; index += 1) {
    const absMin = index * STEP_MIN;
    const day = Math.floor(absMin / 1440);
    const minute = absMin % 1440;
    calib = Math.min(1.05, Math.max(0.95, calib + (rand() - 0.5) * 0.0012));
    const source = truth[Math.max(0, index - lag)]!;
    let raw = source * calib;
    let compressionLow = false;
    if (
      persona.compression &&
      persona.compression.day === day &&
      inWindow(minute, persona.compression.from, persona.compression.to)
    ) {
      const span = persona.compression.to - persona.compression.from;
      const phase = (minute - persona.compression.from) / span;
      raw = persona.true.fastingBaseline - 78 * Math.sin(Math.PI * phase);
      compressionLow = true;
    }
    const cgmCensored = raw <= 40 || raw >= 400;
    const glucose = clipGlucose(raw);
    let gap = Boolean(
      persona.gap && persona.gap.day === day && inWindow(minute, persona.gap.from, persona.gap.to),
    );
    if (!gap && !compressionLow) {
      if (dropout > 0) {
        gap = true;
        dropout -= 1;
      } else if (rand() < 0.0007) {
        dropout = 2 + Math.floor(rand() * 2);
      }
    }
    const worn = !(
      persona.nonwear &&
      persona.nonwear.day === day &&
      inWindow(minute, persona.nonwear.from, persona.nonwear.to)
    );
    const walking = walks.some(
      (walk) => absMin >= walk.min && absMin < walk.min + walk.durationMin,
    );
    const mets = walking ? 4.4 : 1.15 + (rand() - 0.5) * 0.1;
    const hr = walking ? resting + 48 + rand() * 6 : resting + (rand() - 0.5) * 4;
    const kcal = ((mets * 3.5 * persona.weightKg) / 200) * STEP_MIN;
    const prev = readings[index - 1]?.glucose;
    const cgmNoise = !compressionLow && prev != null && Math.abs(glucose - prev) > 4 * STEP_MIN;
    readings.push({
      glucose: gap ? null : glucose,
      hr: worn ? Math.round(hr) : null,
      mets: worn ? round2(mets) : null,
      activityKcal: activityWhenWorn(worn, round2(kcal)),
      worn,
      cgmGap: gap,
      cgmNoise,
      cgmCensored: !gap && cgmCensored,
      compressionLow: !gap && compressionLow,
      cgmSource: gap ? "gap" : "dexcom",
    });
  }
  return readings;
}

function distortLogs(
  persona: Persona,
  meals: Meal[],
  rand: () => number,
): { visible: Meal[]; absorbed: MacroEvent[] } {
  const visible: Meal[] = [];
  const absorbed: MacroEvent[] = meals.map((meal) => ({
    min: meal.min,
    carbs: meal.carbs,
    fiber: meal.fiber,
    protein: meal.protein,
    fat: meal.fat,
    name: meal.name,
  }));
  for (const meal of meals) {
    if (!meal.logged) {
      visible.push(meal);
      continue;
    }
    const jitter = Math.round((rand() - 0.5) * 30);
    const scale = 0.7 + rand() * 0.6;
    visible.push({ ...meal, min: meal.min + jitter, carbs: round2(meal.carbs * scale) });
  }
  for (let day = 0; day < DAYS; day += 1) {
    const count = 1 + (rand() < 0.45 ? 1 : 0);
    for (let slot = 0; slot < count; slot += 1) {
      const minute = Math.round(9 * 60 + rand() * 10 * 60);
      const carbs = round2(10 + rand() * 14);
      const snack: Meal = {
        id: `${persona.id}-d${day}-hidden-${slot}`,
        min: day * 1440 + minute,
        carbs,
        fiber: 1,
        protein: 3,
        fat: 5,
        name: "Unlogged snack",
        logged: false,
        items: [],
      };
      visible.push(snack);
      absorbed.push({ min: snack.min, carbs, fiber: 1, protein: 3, fat: 5, name: snack.name });
    }
  }
  visible.sort((a, b) => a.min - b.min);
  absorbed.sort((a, b) => a.min - b.min);
  return { visible, absorbed };
}

/** The person's usual RMSSD: median over the five fitting nights (0 when HRV is not measured). */
function hrvBaseline(nights: Night[]): number {
  const values = nights
    .slice(0, PARAM_DAYS)
    .map((night) => night.rmssd)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  return values.length ? quantile(values, 0.5) : 0;
}

function nightOf(
  nights: Night[],
  day: number,
  sleepHours?: number,
): { sleepH: number; efficiency: number; rmssd: number } {
  const night = nights[day];
  return {
    sleepH: sleepHours ?? night?.durationH ?? 7,
    efficiency: night?.efficiency ?? 0,
    rmssd: night?.rmssd ?? 0,
  };
}

/** The night before last, whose sleep debt partly carries into today (undefined on day 0). */
function prevNightOf(
  nights: Night[],
  day: number,
): { sleepH: number; efficiency: number; rmssd: number } | undefined {
  return day > 0 && nights[day - 1] ? nightOf(nights, day - 1) : undefined;
}

/**
 * Fitted knobs adjusted by the wearable streams: last night's sleep, sleep
 * efficiency and HRV (carb sensitivity and dawn rise) and walks earlier
 * today (post-walk insulin sensitivity). A masked stream contributes nothing.
 */
function wearableKnobs(
  knobs: TwinKnobs,
  nights: Night[],
  day: number,
  nowMin?: number,
  walks?: WalkEvent[],
  mask?: { sleep?: boolean; walks?: boolean },
  sleepHours?: number,
): TwinKnobs {
  const useSleep = mask?.sleep !== false;
  const night = nightOf(nights, day, sleepHours);
  const base = hrvBaseline(nights);
  const previous = prevNightOf(nights, day);
  const sens = useSleep ? wearableSensitivity(night, base, previous) : 1;
  const dawn = useSleep ? wearableDawn(night, base, previous) : 1;
  const walk =
    mask?.walks !== false && walks && nowMin != null ? postWalkSensitivity(nowMin, walks) : 1;
  return {
    ...knobs,
    carbSensitivity: knobs.carbSensitivity * sens * walk,
    dawnAmp: knobs.dawnAmp * dawn,
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
  const t = Math.min(1, (ahead - 60) / 60);
  return mix(bands[60], bands[120], t);
}

/**
 * The twin's sulfonylurea term, switched on by the record's medication list.
 * Insulin secretion continues through long fasting gaps, so glucose falls
 * once the gap since the last meal passes 3 h in the afternoon and evening
 * (to −48 mg/dL by 260 min) and 5 h overnight (to −35 mg/dL). Sizes follow
 * sulfonylurea pharmacodynamics and sit close to the stress-test generator's
 * (−55 / −40 step), so simulated drug lows are partly caught by construction.
 */
function twinMedOffset(
  absMin: number,
  meals: MacroEvent[],
  fromDay: number | null | undefined,
): number {
  if (fromDay == null || Math.floor(absMin / 1440) < fromDay) return 0;
  let last = -1e9;
  for (const meal of meals) if (meal.min <= absMin && meal.min > last) last = meal.min;
  const gap = absMin - last;
  const minute = ((absMin % 1440) + 1440) % 1440;
  if (minute >= 15 * 60 && minute < 23 * 60)
    return -48 * Math.min(1, Math.max(0, (gap - 180) / 80));
  if (minute >= 23 * 60 || minute < 6 * 60)
    return -35 * Math.min(1, Math.max(0, (gap - 300) / 80));
  return 0;
}

/** Sulfonylurea also blunts meal excursions (more insulin per meal). */
const MED_CARB_FACTOR = 0.75;

function medKnobs(knobs: TwinKnobs, nowMin: number, fromDay: number | null | undefined): TwinKnobs {
  if (fromDay == null || Math.floor(nowMin / 1440) < fromDay) return knobs;
  return { ...knobs, carbSensitivity: knobs.carbSensitivity * MED_CARB_FACTOR };
}

/**
 * Sulfonylurea low guard (simulated record only). From 15:00 to 06:00 on the
 * drug, with glucose under `maxGlucose`, the 60-min low trough assumes the rest
 * of the fasting-gap drop (to −48 mg/dL in the evening, −35 overnight) lands
 * within `withinMin`, once the gap since the last logged meal reaches `minGap`.
 * If CGM is falling at least `fallRate` after the twin's drop should already be
 * over (gap > 260 min, as after an unlogged snack), the whole drop is assumed to
 * be still ahead. The values come from `calibrateDrugGuard` on an independent
 * realization of the ward (persona seeds + CALIBRATION_SEED_OFFSET), so the
 * scored seed's test days never informed them.
 */
export type DrugGuard = { minGap: number; maxGlucose: number; fallRate: number; withinMin: number };

export const DRUG_LOW_GUARD: DrugGuard = { minGap: 240, maxGlucose: 105, fallRate: -1, withinMin: 60 };

function drugLowDrop(
  nowMin: number,
  current: number,
  earlier: number | null,
  meals: MacroEvent[],
  fromDay: number | null | undefined,
  guard: DrugGuard | null = DRUG_LOW_GUARD,
): number {
  if (guard == null || fromDay == null || Math.floor(nowMin / 1440) < fromDay) return 0;
  if (current >= guard.maxGlucose) return 0;
  const minute = ((nowMin % 1440) + 1440) % 1440;
  const evening = minute >= 15 * 60 && minute < 23 * 60;
  const overnight = minute >= 23 * 60 || minute < 6 * 60;
  if (!evening && !overnight) return 0;
  const full = evening ? -48 : -35;
  let last = -1e9;
  for (const meal of meals) if (meal.min <= nowMin && meal.min > last) last = meal.min;
  const gap = nowMin - last;
  const falling = earlier != null && (current - earlier) / 15 <= guard.fallRate;
  if (gap > 260) return falling ? full : 0;
  if (gap < guard.minGap) return 0;
  return Math.min(0, full - twinMedOffset(nowMin, meals, fromDay));
}

/** Shift a curve's median and band down by `drop`, reached linearly by `withinMin` and held. */
function withDrop(curve: CurvePoint[], drop: number, withinMin: number): CurvePoint[] {
  if (!drop) return curve;
  return curve.map((point) => {
    const shift = drop * Math.min(1, point.minutesAhead / withinMin);
    return { ...point, p10: point.p10 + shift, p50: point.p50 + shift, p90: point.p90 + shift };
  });
}

/** Minutes since the last meal of at least `minCarbs` grams at or before now (null when none). */
function minutesSinceMeal(meals: MacroEvent[], nowMin: number, minCarbs = 15): number | null {
  let last: number | null = null;
  for (const meal of meals) {
    if (meal.carbs >= minCarbs && meal.min <= nowMin && (last == null || meal.min > last))
      last = meal.min;
  }
  return last == null ? null : nowMin - last;
}

/** Trend correction at `ahead` minutes, linear between 0, 30, 60 and 120 min as bandAt mixes bands. */
function trendShift(ahead: number, coef: TrendCorrection["coef"], slope: number): number {
  const at = (h: 30 | 60 | 120) => coef[h].slopeGain * slope * h + coef[h].bias;
  if (ahead <= 0) return 0;
  if (ahead <= 30) return (at(30) * ahead) / 30;
  if (ahead <= 60) return at(30) + ((at(60) - at(30)) * (ahead - 30)) / 30;
  return at(60) + (at(120) - at(60)) * Math.min(1, (ahead - 60) / 60);
}

export function project(input: {
  nowMin: number;
  glucoseNow: number;
  meals: MacroEvent[];
  walks: WalkEvent[];
  knobs: TwinKnobs;
  bands: Record<30 | 60 | 120, BandOffset>;
  horizonMin?: number;
  medFromDay?: number | null;
  /** Real data: trend correction and the CGM slope over the last 30 min (mg/dL per min). */
  trend?: { coef: TrendCorrection["coef"]; slope: number };
}): CurvePoint[] {
  const horizon = input.horizonMin ?? 120;
  const base = forecastCurve({
    nowMin: input.nowMin,
    glucoseNow: input.glucoseNow,
    meals: input.meals,
    walks: input.walks,
    knobs: medKnobs(input.knobs, input.nowMin, input.medFromDay),
    band: { q10: 0, q90: 0 },
    horizonMin: horizon,
  });
  const medNow = twinMedOffset(input.nowMin, input.meals, input.medFromDay);
  return base.map((point) => {
    const band = bandAt(point.minutesAhead, input.bands);
    const med =
      twinMedOffset(input.nowMin + point.minutesAhead, input.meals, input.medFromDay) - medNow;
    const shift = input.trend ? trendShift(point.minutesAhead, input.trend.coef, input.trend.slope) : 0;
    const center = point.p50 + med + shift;
    const [p10, p50, p90] = orderQuantiles(center + band.q10, center, center + band.q90);
    return { minutesAhead: point.minutesAhead, p10, p50, p90 };
  });
}

function loggedMealsUntil(meals: Meal[], nowMin: number): MacroEvent[] {
  return meals.filter((meal) => meal.logged && meal.min <= nowMin);
}

type UsualMeal = MacroEvent & { atMin: number };

function slotIndex(min: number): number {
  const clock = ((min % 1440) + 1440) % 1440;
  return clock < 11 * 60 ? 0 : clock < 16 * 60 ? 1 : 2;
}

/**
 * The person's habitual next meal, learned on the five fitting days: median
 * clock time and macros per slot, scaled by how often that slot was eaten.
 * It appears only when the usual time is within the next 120 minutes and no
 * meal has been logged in that slot today yet. Meals logged later never
 * switch it off, so the prior cannot see the future.
 */
function usualMealFrom(meals: Meal[], nowMin: number): UsualMeal | null {
  const buckets: Meal[][] = [[], [], []];
  const daysWith: Set<number>[] = [new Set(), new Set(), new Set()];
  for (const meal of meals) {
    if (!meal.logged || meal.min >= PARAM_DAYS * 1440 || meal.carbs < 8) continue;
    const slot = slotIndex(meal.min);
    buckets[slot]!.push(meal);
    daysWith[slot]!.add(Math.floor(meal.min / 1440));
  }
  const dayStart = Math.floor(nowMin / 1440) * 1440;
  const names = ["Usual breakfast", "Usual lunch", "Usual dinner"];
  let best: UsualMeal | null = null;
  buckets.forEach((bucket, slot) => {
    if (!bucket.length || best) return;
    const atMin = dayStart + medianClock(bucket.map((meal) => meal.min % 1440));
    if (atMin <= nowMin || atMin > nowMin + 120) return;
    const eatenToday = meals.some(
      (meal) =>
        meal.logged &&
        meal.carbs >= 8 &&
        meal.min >= dayStart &&
        meal.min <= nowMin &&
        slotIndex(meal.min) === slot,
    );
    if (eatenToday) return;
    const adherence = daysWith[slot]!.size / PARAM_DAYS;
    best = {
      min: atMin,
      atMin,
      carbs: medianClock(bucket.map((meal) => meal.carbs)) * adherence,
      fiber: medianClock(bucket.map((meal) => meal.fiber)) * adherence,
      protein: medianClock(bucket.map((meal) => meal.protein)) * adherence,
      fat: medianClock(bucket.map((meal) => meal.fat)) * adherence,
      name: `${names[slot]} (habit, not logged yet)`,
    };
  });
  return best;
}

/** Meals the spike alert projects: everything logged so far plus the habitual next meal. */
function alertMeals(meals: Meal[], nowMin: number): MacroEvent[] {
  const seen = loggedMealsUntil(meals, nowMin);
  const usual = usualMealFrom(meals, nowMin);
  return usual ? [...seen, usual] : seen;
}

function loggedWalksUntil(walks: Walk[], nowMin: number): WalkEvent[] {
  return walks.filter((walk) => walk.logged && walk.min <= nowMin);
}

function dayOfIndex(index: number): number {
  return Math.floor((index * STEP_MIN) / 1440);
}

function estimateParams(
  persona: Persona,
  meals: Meal[],
  walks: Walk[],
  nights: Night[],
  readings: Reading[],
  prior: TwinKnobs = POP[persona.group],
): TwinParams {
  const pop = prior;
  const sensSamples: number[] = [];
  const recoveries: number[] = [];
  for (const meal of meals) {
    if (!meal.logged || meal.min >= PARAM_DAYS * 1440) continue;
    const isolated = meals.every(
      (other) => other.id === meal.id || !other.logged || Math.abs(other.min - meal.min) >= 180,
    );
    const walkNear = walks.some((walk) => Math.abs(walk.min - meal.min) < 150);
    if (!isolated || walkNear || meal.carbs < 8) continue;
    const index = Math.round(meal.min / STEP_MIN);
    const pre = glucoseAt(readings, index) ?? glucoseAt(readings, index - 1);
    if (pre == null) continue;
    let peak = pre;
    let peakIndex = index;
    const last = Math.min(SERIES_LEN - 1, index + Math.round(150 / STEP_MIN));
    for (let k = index + 1; k <= last; k += 1) {
      const value = glucoseAt(readings, k);
      if (value != null && value > peak) {
        peak = value;
        peakIndex = k;
      }
    }
    const rise = peak - pre;
    if (rise < 8) continue;
    const day = Math.floor(meal.min / 1440);
    const wearScale =
      wearableSensitivity(nightOf(nights, day), hrvBaseline(nights), prevNightOf(nights, day)) *
      postWalkSensitivity(
        meal.min,
        walks.filter((walk) => walk.logged),
      );
    const baseSens =
      rise / (meal.carbs / 10) / (wearScale * mealTimeFactor(meal.min) * mealSizeFactor(meal.carbs));
    if (Number.isFinite(baseSens) && baseSens > 0 && baseSens < 40) sensSamples.push(baseSens);
    let recovery: number | null = null;
    for (let k = peakIndex; k <= Math.min(SERIES_LEN - 1, peakIndex + 48); k += 1) {
      const value = glucoseAt(readings, k);
      if (value != null && Math.abs(value - pre) <= 10) {
        recovery = (k - peakIndex) * STEP_MIN;
        break;
      }
    }
    if (recovery != null) recoveries.push(recovery);
  }
  const actSamples: number[] = [];
  const sensForAct = sensSamples.length
    ? sensSamples.reduce((s, v) => s + v, 0) / sensSamples.length
    : pop.carbSensitivity;
  const fastingSamples: number[] = [];
  for (let day = 0; day < PARAM_DAYS; day += 1) {
    for (let minute = 3 * 60; minute < 6 * 60; minute += STEP_MIN) {
      const value = glucoseAt(readings, (day * 1440 + minute) / STEP_MIN);
      if (value != null) fastingSamples.push(value);
    }
  }
  fastingSamples.sort((a, b) => a - b);
  const fasting = fastingSamples.length ? quantile(fastingSamples, 0.5) : pop.fastingBaseline;
  for (const walk of walks) {
    if (walk.min >= PARAM_DAYS * 1440) continue;
    const i0 = Math.round(walk.min / STEP_MIN);
    const i1 = Math.round((walk.min + walk.durationMin) / STEP_MIN);
    const g0 = glucoseAt(readings, i0);
    const g1 = glucoseAt(readings, i1);
    if (g0 == null || g1 == null) continue;
    const day = Math.floor(walk.min / 1440);
    const knobs = wearableKnobs(
      { ...pop, carbSensitivity: sensForAct, activityEffect: 0, fastingBaseline: fasting },
      nights,
      day,
    );
    const expectedDt =
      levelAt(
        walk.min + walk.durationMin,
        meals.filter((m) => m.logged),
        [],
        knobs,
      ) -
      levelAt(
        walk.min,
        meals.filter((m) => m.logged),
        [],
        knobs,
      );
    const extraDrop = expectedDt - (g1 - g0);
    const per30 = extraDrop / (walk.durationMin / 30);
    if (Number.isFinite(per30)) actSamples.push(Math.min(80, Math.max(0, per30)));
  }
  const carbSensitivity = Math.min(40, Math.max(0.5, shrink(sensSamples, pop.carbSensitivity, 3)));
  const activityEffect = Math.min(80, Math.max(0, shrink(actSamples, pop.activityEffect, 1)));
  recoveries.sort((a, b) => a - b);
  const carbMean = sensSamples.length
    ? sensSamples.reduce((sum, value) => sum + value, 0) / sensSamples.length
    : null;
  const actMean = actSamples.length
    ? actSamples.reduce((sum, value) => sum + value, 0) / actSamples.length
    : null;
  const dawnSamples: number[] = [];
  for (let day = 0; day < PARAM_DAYS; day += 1) {
    const at4 = glucoseAt(readings, (day * 1440 + 4 * 60) / STEP_MIN);
    const at8 = glucoseAt(readings, (day * 1440 + 8 * 60) / STEP_MIN);
    if (at4 == null || at8 == null) continue;
    dawnSamples.push(
      Math.max(0, at8 - at4) /
        wearableDawn(nightOf(nights, day), hrvBaseline(nights), prevNightOf(nights, day)),
    );
  }
  const dawnAmp = Math.min(40, Math.max(0, shrink(dawnSamples, pop.dawnAmp, 2)));
  const tauMin = Math.min(240, Math.max(40, shrink(recoveries, pop.tauMin, 2)));
  return {
    carbSensitivity: round2(carbSensitivity),
    activityEffect: round2(activityEffect),
    fastingBaseline: round1(fasting),
    recoveryMin: recoveries.length ? Math.round(quantile(recoveries, 0.5)) : null,
    isolatedMeals: sensSamples.length,
    knobs: {
      carbSensitivity,
      activityEffect,
      fastingBaseline: fasting,
      dawnAmp,
      tauMin,
    },
    calibration: {
      carbMean,
      carbN: sensSamples.length,
      actMean,
      actN: actSamples.length,
      fastingMedian: fastingSamples.length ? fasting : null,
    },
    personalTrust: 1,
  };
}

const TRUST_STEPS = [1, 0.75, 0.5, 0.25, 0];

function blendKnobs(prior: TwinKnobs, personal: TwinKnobs, trust: number): TwinKnobs {
  const mix = (a: number, b: number) => a + trust * (b - a);
  return {
    carbSensitivity: mix(prior.carbSensitivity, personal.carbSensitivity),
    activityEffect: mix(prior.activityEffect, personal.activityEffect),
    fastingBaseline: mix(prior.fastingBaseline, personal.fastingBaseline),
    dawnAmp: mix(prior.dawnAmp, personal.dawnAmp),
    tauMin: mix(prior.tauMin, personal.tauMin),
  };
}

/** Squared 60-min point-forecast errors on the validation days (after fitting, before scoring), grouped by day. */
/**
 * Whether the meal-scaled residual (physics.ts forecastCurve) helps this ward:
 * pooled 60-min RMSE of each fitted twin on validation days 6–9, both ways.
 * The ward is built with the plain residual; the fusion test fails if this
 * choice ever flips, so the switch would then need wiring through the fit.
 */
function chooseMealResidual(models: PatientModel[]): Cohort["mealResidual"] {
  const rmseFor = (mode: "plain" | "scaled") => {
    const errors = models.flatMap((model) =>
      validationErrors(
        { ...model.params.knobs, mealResidual: mode },
        model.meals,
        model.walks,
        model.nights,
        model.readings,
      ).flat(),
    );
    return round2(Math.sqrt(errors.reduce((sum, value) => sum + value, 0) / errors.length));
  };
  const plain = rmseFor("plain");
  const scaled = rmseFor("scaled");
  return { chosen: scaled < plain ? "scaled" : "plain", validationRmse60: { plain, scaled } };
}

function validationErrors(
  knobs: TwinKnobs,
  meals: Meal[],
  walks: Walk[],
  nights: Night[],
  readings: Reading[],
): number[][] {
  const byDay: number[][] = [];
  for (let day = PARAM_DAYS; day < CONF_END; day += 1) {
    const errors: number[] = [];
    for (let slot = 0; slot < STEPS_PER_DAY; slot += 3) {
      const index = day * STEPS_PER_DAY + slot;
      const actual = glucoseAt(readings, index + 12);
      const pred = pointForecast(index, 12, readings, meals, walks, nights, knobs);
      if (actual == null || pred == null) continue;
      errors.push((pred - actual) ** 2);
    }
    byDay.push(errors);
  }
  return byDay;
}

function validationRmse60(
  knobs: TwinKnobs,
  meals: Meal[],
  walks: Walk[],
  nights: Night[],
  readings: Reading[],
): number {
  const all = validationErrors(knobs, meals, walks, nights, readings).flat();
  return all.length
    ? Math.sqrt(all.reduce((sum, value) => sum + value, 0) / all.length)
    : Number.POSITIVE_INFINITY;
}

/**
 * True when `candidate` beats `baseline` on the validation days by more than
 * one standard error of the day-by-day difference in mean squared error.
 * Days are the blocks, because errors within a day are correlated.
 */
function clearlyBetter(candidate: number[][], baseline: number[][]): boolean {
  const diffs: number[] = [];
  candidate.forEach((errors, day) => {
    const base = baseline[day] ?? [];
    if (!errors.length || errors.length !== base.length) return;
    const mean = (values: number[]) =>
      values.reduce((sum, value) => sum + value, 0) / values.length;
    diffs.push(mean(base) - mean(errors));
  });
  if (diffs.length < 2) return false;
  const gain = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
  const sd = Math.sqrt(
    diffs.reduce((sum, value) => sum + (value - gain) ** 2, 0) / (diffs.length - 1),
  );
  return gain > sd / Math.sqrt(diffs.length);
}

/**
 * Empirical shrinkage chosen on held-out validation days: blend the personal
 * fit toward the group prior by the trust level with the lowest validation
 * error. Floor: unless that blend beats the group prior by more than one
 * standard error on those days, the personal weight is 0 and the twin keeps
 * the prior, so a few noisy meals cannot pull it below the population model.
 * The scored days (9 onward) are never used. With a record prior, a second
 * floor applies: unless the record-based twin also beats the group prior by
 * more than one standard error, the twin falls back to the group prior.
 */
function chooseTrust(
  params: TwinParams,
  prior: TwinKnobs,
  meals: Meal[],
  walks: Walk[],
  nights: Night[],
  readings: Reading[],
  groupFloor?: TwinKnobs,
): TwinParams {
  let best = { trust: 1, err: Number.POSITIVE_INFINITY };
  for (const trust of TRUST_STEPS) {
    const err = validationRmse60(
      blendKnobs(prior, params.knobs, trust),
      meals,
      walks,
      nights,
      readings,
    );
    if (err < best.err - 1e-6) best = { trust, err };
  }
  if (
    best.trust > 0 &&
    !clearlyBetter(
      validationErrors(blendKnobs(prior, params.knobs, best.trust), meals, walks, nights, readings),
      validationErrors(prior, meals, walks, nights, readings),
    )
  ) {
    best = { trust: 0, err: validationRmse60(prior, meals, walks, nights, readings) };
  }
  let knobs = blendKnobs(prior, params.knobs, best.trust);
  let source: "record" | "group" = groupFloor ? "record" : "group";
  if (
    groupFloor &&
    !clearlyBetter(
      validationErrors(knobs, meals, walks, nights, readings),
      validationErrors(groupFloor, meals, walks, nights, readings),
    )
  ) {
    knobs = groupFloor;
    best = { trust: 0, err: validationRmse60(groupFloor, meals, walks, nights, readings) };
    source = "group";
  }
  return {
    ...params,
    carbSensitivity: round2(knobs.carbSensitivity),
    activityEffect: round2(knobs.activityEffect),
    fastingBaseline: round1(knobs.fastingBaseline),
    knobs,
    personalTrust: best.trust,
    prior: source,
  };
}

function shrink(samples: number[], pop: number, k: number): number {
  if (!samples.length) return pop;
  const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
  return (samples.length * mean + k * pop) / (samples.length + k);
}

function pointForecast(
  index: number,
  aheadSteps: number,
  readings: Reading[],
  meals: Meal[],
  walks: Walk[],
  nights: Night[],
  knobs: TwinKnobs,
  mask?: { meals?: boolean; walks?: boolean; sleep?: boolean },
  medFromDay: number | null = null,
): number | null {
  const current = glucoseAt(readings, index);
  const future = glucoseAt(readings, index + aheadSteps);
  if (current == null || future == null) return null;
  const nowMin = index * STEP_MIN;
  const day = dayOfIndex(index);
  const seenWalks = mask?.walks === false ? [] : loggedWalksUntil(walks, nowMin);
  const seenMeals = mask?.meals === false ? [] : loggedMealsUntil(meals, nowMin);
  const curve = forecastCurve({
    nowMin,
    glucoseNow: current,
    meals: seenMeals,
    walks: seenWalks,
    knobs: medKnobs(wearableKnobs(knobs, nights, day, nowMin, seenWalks, mask), nowMin, medFromDay),
    band: { q10: 0, q90: 0 },
    horizonMin: aheadSteps * STEP_MIN,
  });
  const end = nowMin + aheadSteps * STEP_MIN;
  const med =
    twinMedOffset(end, seenMeals, medFromDay) - twinMedOffset(nowMin, seenMeals, medFromDay);
  return curve[curve.length - 1]!.p50 + med;
}

function fitBands(
  meals: Meal[],
  walks: Walk[],
  nights: Night[],
  readings: Reading[],
  knobs: TwinKnobs,
  medFromDay: number | null = null,
): Record<30 | 60 | 120, BandOffset> {
  const horizons = [30, 60, 120] as const;
  const bands = {} as Record<30 | 60 | 120, BandOffset>;
  for (const horizon of horizons) {
    const errors: number[] = [];
    const steps = horizon / STEP_MIN;
    for (let day = CONF_START; day < CONF_END; day += 1) {
      for (let slot = 0; slot < STEPS_PER_DAY; slot += 6) {
        const index = day * STEPS_PER_DAY + slot;
        const actual = glucoseAt(readings, index + steps);
        const pred = pointForecast(
          index,
          steps,
          readings,
          meals,
          walks,
          nights,
          knobs,
          undefined,
          medFromDay,
        );
        if (actual == null || pred == null) continue;
        errors.push(actual - pred);
      }
    }
    bands[horizon] = conformalBand(errors);
  }
  return bands;
}

function leadOf(
  readings: Reading[],
  index: number,
  kind: "spike" | "low",
  current: number,
): { leadMin: number | null; cameTrue: boolean } {
  const steps = kind === "spike" ? 24 : 12;
  const last = Math.min(readings.length - 1, index + steps);
  for (let k = index + 1; k <= last; k += 1) {
    const value = glucoseAt(readings, k);
    if (value == null) continue;
    const hit = kind === "spike" ? value > 180 || value - current >= 50 : value < 70;
    if (hit) return { leadMin: (k - index) * STEP_MIN, cameTrue: true };
  }
  return { leadMin: null, cameTrue: false };
}

function reasonsFor(
  nowMin: number,
  glucoseNow: number,
  knobs: TwinKnobs,
  meals: MacroEvent[],
  walks: WalkEvent[],
  curve: CurvePoint[],
  medFromDay: number | null = null,
  kind: "spike" | "low" = "spike",
): Reason[] {
  let peak = curve[0]!;
  for (const point of curve) {
    if (kind === "low" ? point.p50 < peak.p50 : point.p50 > peak.p50) peak = point;
  }
  const peakMin = nowMin + peak.minutesAhead;
  const items: Reason[] = [];
  let mealMag = 0;
  let mealText = "";
  for (const meal of meals) {
    const delay = peakMin - meal.min;
    const mag = mealOffset(
      delay,
      meal.carbs,
      meal.fiber,
      knobs.carbSensitivity,
      mealClockMin(meal, knobs),
    );
    if (mag > mealMag) {
      mealMag = mag;
      const started = meal.min <= nowMin;
      const rel = started
        ? `${Math.round(nowMin - meal.min)} min ago`
        : `in ${Math.round(meal.min - nowMin)} min`;
      mealText = `${Math.round(meal.carbs)} g carbs (${meal.name}), ${rel}`;
    }
  }
  if (mealMag >= 1 && kind === "spike")
    items.push({ group: "Meal", text: `The peak lines up with ${mealText}.`, magnitude: mealMag });
  const medDrop =
    twinMedOffset(peakMin, meals, medFromDay) - twinMedOffset(nowMin, meals, medFromDay);
  if (medDrop <= -5) {
    const last = meals.reduce(
      (acc, meal) => (meal.min <= nowMin && meal.min > acc ? meal.min : acc),
      -1e9,
    );
    const since =
      last > -1e9 ? `${Math.round((nowMin - last) / 60)} h since the last meal` : "no meal logged";
    items.push({
      group: "Medicine",
      text: `Sulfonylurea on the record and ${since}: the twin expects a further fall of about ${Math.round(Math.abs(medDrop))} mg/dL.`,
      magnitude: Math.abs(medDrop),
    });
  }
  let walkMag = 0;
  let walkText = "";
  for (const walk of walks) {
    const mag = walkOffset(peakMin - walk.min, walk.durationMin, knobs.activityEffect);
    if (Math.abs(mag) > Math.abs(walkMag)) {
      walkMag = mag;
      const rel =
        walk.min <= nowMin
          ? `${Math.round(nowMin - walk.min)} min ago`
          : `in ${Math.round(walk.min - nowMin)} min`;
      walkText = `A ${Math.round(walk.durationMin)} min walk ${rel} pulls glucose down by about ${Math.round(Math.abs(mag))} mg/dL.`;
    }
  }
  if (Math.abs(walkMag) >= 1)
    items.push({ group: "Activity", text: walkText, magnitude: Math.abs(walkMag) });
  const dawn = circadianPart(peakMin, knobs);
  if (Math.abs(dawn) >= 2) {
    items.push({
      group: "Time of day",
      text: `Time of day adds about ${Math.round(dawn)} mg/dL compared with the fasting baseline.`,
      magnitude: Math.abs(dawn),
    });
  }
  const residual = glucoseNow - knobs.fastingBaseline;
  if (Math.abs(residual) >= 4) {
    items.push({
      group: "Recent glucose",
      text: `Glucose is ${Math.round(Math.abs(residual))} mg/dL ${residual > 0 ? "above" : "below"} the ${Math.round(knobs.fastingBaseline)} mg/dL fasting baseline.`,
      magnitude: Math.abs(residual),
    });
  }
  items.sort((a, b) => b.magnitude - a.magnitude);
  return items.slice(0, 3);
}

/** Put the sulfonylurea guard first in a low alert's reasons when it projected the low. */
function withDrugReason(
  reasons: Reason[],
  drop: number,
  nowMin: number,
  meals: MacroEvent[],
): Reason[] {
  if (drop > -5) return reasons;
  const last = meals.reduce((acc, meal) => (meal.min <= nowMin && meal.min > acc ? meal.min : acc), -1e9);
  const since = last > -1e9 ? `${Math.round((nowMin - last) / 60)} h since the last logged meal` : "no meal logged";
  const reason: Reason = {
    group: "Medicine",
    text: `Sulfonylurea on the record and ${since}: the low guard expects up to ${Math.round(Math.abs(drop))} mg/dL more fall within the hour.`,
    magnitude: Math.abs(drop),
  };
  return [reason, ...reasons.filter((item) => item.group !== "Medicine")].slice(0, 3);
}

function circadianPart(absMin: number, knobs: TwinKnobs): number {
  const hour = (((absMin % 1440) + 1440) % 1440) / 60;
  let dawn = 0;
  if (hour >= 4 && hour <= 9) dawn = knobs.dawnAmp * Math.sin(Math.PI * ((hour - 4) / 5));
  return dawn + 3.5 * Math.sin(((hour - 9) / 24) * Math.PI * 2);
}

function buildAlerts(
  patientId: string,
  readings: Reading[],
  meals: Meal[],
  walks: Walk[],
  nights: Night[],
  knobs: TwinKnobs,
  bands: Record<30 | 60 | 120, BandOffset>,
  readyAt = EVAL_START * STEPS_PER_DAY,
  lowScale = 1,
  spikeScale = 1,
  medFromDay: number | null = null,
  lowTrend: LowTrendRule | null = null,
  cachedSamples?: Sample[],
  mask?: { sleep?: boolean; walks?: boolean },
  drugGuard: DrugGuard | null = DRUG_LOW_GUARD,
): {
  samples: Sample[];
  alerts: Alert[];
  spikeProb: Float32Array;
  lowProb: Float32Array;
  active: Uint8Array;
  driftStart: number | null;
  driftRecovered: number | null;
} {
  const length = readings.length;
  const spikeProb = new Float32Array(length);
  const lowProb = new Float32Array(length);
  const samples: Sample[] = cachedSamples ?? [];
  for (let index = 0; index < length; index += 1) {
    if (cachedSamples) {
      spikeProb[index] = samples[index]!.spike;
      lowProb[index] = samples[index]!.low;
      continue;
    }
    samples.push(
      sampleAt(
        index,
        readings,
        meals,
        walks,
        nights,
        knobs,
        bands,
        spikeProb,
        lowProb,
        medFromDay,
        lowTrend,
        mask,
        drugGuard,
      ),
    );
  }
  const outside = samples.map((sample, index) => {
    if (index < readyAt) return false;
    const earlier = samples[index - 6];
    const value = glucoseAt(readings, index);
    if (!earlier || earlier.lo == null || earlier.hi == null || value == null) return false;
    return value < earlier.lo || value > earlier.hi;
  });
  const drift = driftWindows(outside);
  const fires = hygieneFires(
    samples.map((sample, index) => ({
      spike: Math.min(1, sample.spike * spikeScale),
      low: Math.min(1, sample.low * lowScale),
      gap: sample.gap,
      day: dayOfIndex(index),
    })),
  );
  const alerts: Alert[] = [];
  const active = new Uint8Array(length);
  let spikeOn = false;
  let lowOn = false;
  let spikeUrgent = false;
  let lowUrgent = false;
  let activeSpike: Alert | null = null;
  for (let index = 0; index < length; index += 1) {
    if (spikeProb[index]! * spikeScale < 0.4) {
      spikeOn = false;
      spikeUrgent = false;
      activeSpike = null;
    }
    if (lowProb[index]! * lowScale < 0.4) {
      lowOn = false;
      lowUrgent = false;
    }
    const kind = fires[index];
    if (kind === "low") lowOn = true;
    if (kind === "spike") spikeOn = true;
    const current = readings[index]?.glucose;
    if (kind && current != null) {
      const nowMin = index * STEP_MIN;
      const day = dayOfIndex(index);
      const alertMealList =
        kind === "spike" ? alertMeals(meals, nowMin) : loggedMealsUntil(meals, nowMin);
      const walksNow = mask?.walks === false ? [] : loggedWalksUntil(walks, nowMin);
      const knobsNow = wearableKnobs(knobs, nights, day, nowMin, walksNow, mask);
      const curve = project({
        nowMin,
        glucoseNow: current,
        meals: alertMealList,
        walks: walksNow,
        knobs: knobsNow,
        bands,
        medFromDay,
      });
      const severity: Alert["severity"] =
        kind === "low" || peakOf(curve) > 250 || minutesAbove(curve, 180) >= 60
          ? "urgent"
          : "watch";
      if (kind === "low") lowUrgent = severity === "urgent";
      if (kind === "spike") spikeUrgent = severity === "urgent";
      const outcome = leadOf(readings, index, kind, current);
      const probability = kind === "spike" ? spikeProb[index]! : lowProb[index]!;
      const alert: Alert = {
        id: `${patientId}-${kind}-${index}`,
        index,
        kind,
        probability,
        leadMin: outcome.leadMin,
        cameTrue: outcome.cameTrue,
        reasons: withDrugReason(
          reasonsFor(nowMin, current, knobsNow, alertMealList, walksNow, curve, medFromDay, kind),
          kind === "low"
            ? drugLowDrop(nowMin, current, glucoseAt(readings, index - 3), alertMealList, medFromDay, drugGuard)
            : 0,
          nowMin,
          alertMealList,
        ),
        severity,
        ...(severity === "urgent" ? { urgentAt: index } : {}),
      };
      alerts.push(alert);
      if (kind === "spike") activeSpike = alert;
    } else if (
      spikeOn &&
      activeSpike &&
      activeSpike.severity === "watch" &&
      samples[index]?.urgent &&
      current != null
    ) {
      // The latched Watch is upgraded in place once the live curve meets the Urgent criteria
      // (usually when the real meal is logged); urgentAt records when that happened.
      const nowMin = index * STEP_MIN;
      const mealsNow = alertMeals(meals, nowMin);
      const walksNow = mask?.walks === false ? [] : loggedWalksUntil(walks, nowMin);
      const knobsNow = wearableKnobs(knobs, nights, dayOfIndex(index), nowMin, walksNow, mask);
      const curve = project({
        nowMin,
        glucoseNow: current,
        meals: mealsNow,
        walks: walksNow,
        knobs: knobsNow,
        bands,
        medFromDay,
      });
      activeSpike.severity = "urgent";
      activeSpike.urgentAt = index;
      activeSpike.probability = Math.max(activeSpike.probability, spikeProb[index]!);
      activeSpike.reasons = reasonsFor(
        nowMin,
        current,
        knobsNow,
        mealsNow,
        walksNow,
        curve,
        medFromDay,
      );
      spikeUrgent = true;
    }
    active[index] =
      (spikeOn ? 1 : 0) | (lowOn ? 2 : 0) | (spikeUrgent ? 4 : 0) | (lowUrgent ? 8 : 0);
  }
  return {
    samples,
    alerts,
    spikeProb,
    lowProb,
    active,
    driftStart: drift.start,
    driftRecovered: drift.recovered,
  };
}

type Sample = {
  spike: number;
  low: number;
  gap: boolean;
  lo: number | null;
  hi: number | null;
  /** The spike curve at this step meets the Urgent criteria (peak > 250 or ≥ 60 min > 180). */
  urgent: boolean;
};

/** Per-step samples of the simulated ward, kept so a threshold change re-runs only the alert pass. */
const sampleCache = new WeakMap<PatientModel, Sample[]>();

/**
 * Spike and low risk the alerts use at one step, recomputed from the model's
 * inputs exactly as buildAlerts does (no cache). Lets a test check that risk at
 * t depends only on data up to t.
 */
export function riskAt(model: PatientModel, index: number): { spike: number; low: number; urgent: boolean } {
  const spikeProb = new Float32Array(model.readings.length);
  const lowProb = new Float32Array(model.readings.length);
  const sample = sampleAt(
    index,
    model.readings,
    model.meals,
    model.walks,
    model.nights,
    model.params.knobs,
    model.bands,
    spikeProb,
    lowProb,
    model.patient.sulfonylureaFromDay ?? null,
    model.alertSetup.lowTrend,
  );
  return { spike: sample.spike, low: sample.low, urgent: sample.urgent };
}

function sampleAt(
  index: number,
  readings: Reading[],
  meals: Meal[],
  walks: Walk[],
  nights: Night[],
  knobs: TwinKnobs,
  bands: Record<30 | 60 | 120, BandOffset>,
  spikeProb: Float32Array,
  lowProb: Float32Array,
  medFromDay: number | null = null,
  lowTrend: LowTrendRule | null = null,
  mask?: { sleep?: boolean; walks?: boolean },
  drugGuard: DrugGuard | null = DRUG_LOW_GUARD,
): Sample {
  const reading = readings[index];
  const blocked =
    !reading ||
    reading.glucose == null ||
    reading.cgmGap ||
    reading.compressionLow ||
    reading.cgmCensored;
  if (blocked || reading.glucose == null) {
    return { spike: 0, low: 0, gap: true, lo: null, hi: null, urgent: false };
  }
  const nowMin = index * STEP_MIN;
  const day = dayOfIndex(index);
  const seenWalks = mask?.walks === false ? [] : loggedWalksUntil(walks, nowMin);
  const dayKnobs = wearableKnobs(knobs, nights, day, nowMin, seenWalks, mask);
  const seenMeals = loggedMealsUntil(meals, nowMin);
  const curve = project({
    nowMin,
    glucoseNow: reading.glucose,
    meals: seenMeals,
    walks: seenWalks,
    knobs: dayKnobs,
    bands,
    medFromDay,
  });
  // Spike risk includes the habitual next meal; low risk never assumes food will arrive.
  const habitMeals = alertMeals(meals, nowMin);
  const spikeCurve =
    habitMeals.length === seenMeals.length
      ? curve
      : project({
          nowMin,
          glucoseNow: reading.glucose,
          meals: habitMeals,
          walks: seenWalks,
          knobs: dayKnobs,
          bands,
          medFromDay,
        });
  const spikeRisk = spikeProbability(reading.glucose, spikeCurve);
  const earlier = glucoseAt(readings, index - 3);
  const sinceMeal = minutesSinceMeal(seenMeals, nowMin);
  const drugActive = medFromDay != null && day >= medFromDay;
  const drop = drugLowDrop(nowMin, reading.glucose, earlier, seenMeals, medFromDay, drugGuard);
  const lowRisk = Math.max(
    twinLowRisk(reading.glucose, withDrop(curve, drop, drugGuard?.withinMin ?? 60), {
      minutesSinceMeal: sinceMeal,
      drugActive,
      postMealCeiling: lowTrend?.postMealCeiling,
    }),
    trendLowRisk(reading.glucose, earlier, lowTrend, {
      twinTrough30: troughWithin(curve, 30),
      minutesSinceMeal: sinceMeal,
    }),
  );
  spikeProb[index] = spikeRisk;
  lowProb[index] = lowRisk;
  const ahead = curve.find((point) => point.minutesAhead === 30);
  return {
    spike: spikeRisk,
    low: lowRisk,
    gap: false,
    lo: ahead?.p10 ?? null,
    hi: ahead?.p90 ?? null,
    urgent: peakOf(spikeCurve) > 250 || minutesAbove(spikeCurve, 180) >= 60,
  };
}


type Running = {
  sseTwin: number;
  ssePers: number;
  ssePop: number;
  abs: number;
  mard: number;
  mardN: number;
  cover: number;
  clarkeAB: number;
  clarkeN: number;
  n: number;
};

function emptyRun(): Running {
  return {
    sseTwin: 0,
    ssePers: 0,
    ssePop: 0,
    abs: 0,
    mard: 0,
    mardN: 0,
    cover: 0,
    clarkeAB: 0,
    clarkeN: 0,
    n: 0,
  };
}

function scorePatient(
  readings: Reading[],
  meals: Meal[],
  walks: Walk[],
  nights: Night[],
  knobs: TwinKnobs,
  pop: TwinKnobs,
  bands: Record<30 | 60 | 120, BandOffset>,
  medFromDay: number | null = null,
): { byH: Record<30 | 60 | 120, Running>; byGroupReady: true } {
  const byH: Record<30 | 60 | 120, Running> = { 30: emptyRun(), 60: emptyRun(), 120: emptyRun() };
  for (let day = EVAL_START; day < DAYS; day += 1) {
    for (let slot = 0; slot < STEPS_PER_DAY; slot += 6) {
      const index = day * STEPS_PER_DAY + slot;
      const current = glucoseAt(readings, index);
      if (current == null) continue;
      const nowMin = index * STEP_MIN;
      const curve = project({
        nowMin,
        glucoseNow: current,
        meals: loggedMealsUntil(meals, nowMin),
        walks: loggedWalksUntil(walks, nowMin),
        knobs: wearableKnobs(knobs, nights, day, nowMin, loggedWalksUntil(walks, nowMin)),
        bands,
        medFromDay,
      });
      for (const horizon of [30, 60, 120] as const) {
        const ahead = horizon / STEP_MIN;
        const actual = glucoseAt(readings, index + ahead);
        if (actual == null) continue;
        const point = curve[ahead]!;
        const popPred = pointForecast(index, ahead, readings, meals, walks, nights, pop);
        if (popPred == null) continue;
        const run = byH[horizon];
        run.n += 1;
        run.sseTwin += (point.p50 - actual) ** 2;
        run.ssePers += (current - actual) ** 2;
        run.ssePop += (popPred - actual) ** 2;
        run.abs += Math.abs(point.p50 - actual);
        if (actual >= 40) {
          run.mard += (Math.abs(point.p50 - actual) / actual) * 100;
          run.mardN += 1;
        }
        if (actual >= point.p10 && actual <= point.p90) run.cover += 1;
        if (horizon === 30) {
          const zone = clarkeZone(actual, point.p50);
          run.clarkeN += 1;
          if (zone === "A" || zone === "B") run.clarkeAB += 1;
        }
      }
    }
  }
  return { byH, byGroupReady: true };
}

const scoreCache = new WeakMap<PatientModel, ReturnType<typeof scorePatient>>();

/** Scores days 10–21 once per model and sets its fit (personal vs group-prior 60-min RMSE). */
function scoreModel(model: PatientModel): ReturnType<typeof scorePatient> {
  let scored = scoreCache.get(model);
  if (!scored) {
    scored = scorePatient(
      model.readings,
      model.meals,
      model.walks,
      model.nights,
      model.params.knobs,
      model.popKnobs,
      model.bands,
      model.patient.sulfonylureaFromDay ?? null,
    );
    scoreCache.set(model, scored);
  }
  model.fit = {
    rmse60: round1(rmse(scored.byH[60].sseTwin, scored.byH[60].n)),
    rmse60Pop: round1(rmse(scored.byH[60].ssePop, scored.byH[60].n)),
    rmse120: round1(rmse(scored.byH[120].sseTwin, scored.byH[120].n)),
  };
  return scored;
}

function rmse(sse: number, n: number): number {
  if (!n) return 0;
  return Math.sqrt(sse / n);
}

/** A clinically severe spike: true peak above 250, or 60 min or more above 180, within 3 h of onset. */
function severeSpike(readings: Reading[], index: number): boolean {
  let peak = 0;
  let above = 0;
  for (let k = index; k < Math.min(readings.length, index + 36); k += 1) {
    const value = glucoseAt(readings, k);
    if (value == null) continue;
    peak = Math.max(peak, value);
    if (value > 180) above += STEP_MIN;
  }
  return peak > 250 || above >= 60;
}

function buildEval(models: PatientModel[], generator: "matched" | "mismatched"): CohortEval {
  const horizons = [30, 60, 120] as const;
  const pooled: Record<30 | 60 | 120, Running> = {
    30: emptyRun(),
    60: emptyRun(),
    120: emptyRun(),
  };
  const perPatient: Record<30 | 60 | 120, number[]> = { 30: [], 60: [], 120: [] };
  const groupPool: Record<Group, Running> = {
    t2d: emptyRun(),
    prediabetes: emptyRun(),
    healthy: emptyRun(),
  };
  const groupN: Record<Group, number> = { t2d: 0, prediabetes: 0, healthy: 0 };
  for (const model of models) {
    groupN[model.patient.group] += 1;
    const scored = scoreModel(model);
    for (const horizon of horizons) {
      const run = scored.byH[horizon];
      const dest = pooled[horizon];
      dest.n += run.n;
      dest.sseTwin += run.sseTwin;
      dest.ssePers += run.ssePers;
      dest.ssePop += run.ssePop;
      dest.abs += run.abs;
      dest.mard += run.mard;
      dest.mardN += run.mardN;
      dest.cover += run.cover;
      dest.clarkeAB += run.clarkeAB;
      dest.clarkeN += run.clarkeN;
      if (run.n) perPatient[horizon].push(rmse(run.sseTwin, run.n));
      if (horizon === 60) {
        const g = groupPool[model.patient.group];
        g.n += run.n;
        g.sseTwin += run.sseTwin;
        g.ssePers += run.ssePers;
      }
    }
  }
  const rng = mulberry32(42);
  const horizonScores: HorizonScore[] = horizons.map((horizon) => {
    const run = pooled[horizon];
    const twin = rmse(run.sseTwin, run.n);
    const pers = rmse(run.ssePers, run.n);
    const values = perPatient[horizon];
    const means: number[] = [];
    for (let i = 0; i < 800; i += 1) {
      let sum = 0;
      for (let j = 0; j < values.length; j += 1)
        sum += values[Math.floor(rng() * values.length)] ?? 0;
      means.push(sum / Math.max(1, values.length));
    }
    means.sort((a, b) => a - b);
    const mean = values.reduce((s, v) => s + v, 0) / Math.max(1, values.length);
    return {
      horizonMin: horizon,
      rmseTwin: round1(twin),
      rmsePersistence: round1(pers),
      rmsePopulation: round1(rmse(run.ssePop, run.n)),
      improvementPct: pers > 0 ? round1(((pers - twin) / pers) * 100) : 0,
      mae: round1(run.abs / Math.max(1, run.n)),
      mard: round1(run.mard / Math.max(1, run.mardN)),
      coverage: Math.round((run.cover / Math.max(1, run.n)) * 1000) / 1000,
      clarkeApb:
        horizon === 30 && run.clarkeN
          ? Math.round((run.clarkeAB / run.clarkeN) * 1000) / 1000
          : null,
      n: run.n,
      patientRmseMean: round1(mean),
      patientRmseCi: [
        round1(means[Math.floor(0.025 * means.length)] ?? mean),
        round1(means[Math.ceil(0.975 * means.length) - 1] ?? mean),
      ],
    };
  });
  const groups: GroupScore[] = (["t2d", "prediabetes", "healthy"] as const).map((group) => {
    const run = groupPool[group];
    const twin = rmse(run.sseTwin, run.n);
    const pers = rmse(run.ssePers, run.n);
    return {
      group,
      patients: groupN[group],
      rmse60: round1(twin),
      rmse60Persistence: round1(pers),
      improvementPct: pers > 0 ? round1(((pers - twin) / pers) * 100) : 0,
    };
  });
  const evalDays = DAYS - EVAL_START;
  const from = EVAL_START * STEPS_PER_DAY;
  let spikeEvents = 0;
  let lowEvents = 0;
  let spikeAlerts = 0;
  let lowAlerts = 0;
  let spikeHits = 0;
  let lowHits = 0;
  let spikeTrue = 0;
  let lowTrue = 0;
  const leads: number[] = [];
  let falseAlerts = 0;
  let urgentAlerts = 0;
  let urgentHits = 0;
  let urgentHitsAll = 0;
  let urgentEvents = 0;
  let urgentTrue = 0;
  const spikeLeads: number[] = [];
  for (const model of models) {
    const found = glucoseEventsOf(model);
    const spikes = found.spikes.filter((index) => index >= from);
    const lows = found.lows.filter((index) => index >= from);
    const alerts = model.alerts
      .filter((alert) => alert.index >= from)
      .map((alert) => ({ index: alert.index, kind: alert.kind }));
    const scored = scoreAlertEvents(spikes, lows, alerts, STEP_MIN);
    spikeEvents += scored.spikeEvents;
    lowEvents += scored.lowEvents;
    spikeAlerts += scored.spikeAlerts;
    lowAlerts += scored.lowAlerts;
    spikeHits += scored.spikeHits;
    lowHits += scored.lowHits;
    spikeTrue += scored.spikeAlerts - scored.spikeFalse;
    lowTrue += scored.lowAlerts - scored.lowFalse;
    falseAlerts += scored.spikeFalse + scored.lowFalse;
    leads.push(...scored.leads);
    spikeLeads.push(...scoreAlertEvents(spikes, [], alerts, STEP_MIN).leads);
    // Urgent alerts count from the step they became Urgent (fire time, or the upgrade).
    const urgent = model.alerts
      .filter((alert) => alert.severity === "urgent" && (alert.urgentAt ?? alert.index) >= from)
      .map((alert) => ({ index: alert.urgentAt ?? alert.index, kind: alert.kind }));
    const urgentScored = scoreAlertEvents(spikes, lows, urgent, STEP_MIN);
    const severeSpikes = spikes.filter((index) => severeSpike(model.readings, index));
    const severeScored = scoreAlertEvents(severeSpikes, lows, urgent, STEP_MIN);
    urgentEvents += severeSpikes.length + lows.length;
    urgentAlerts += urgentScored.spikeAlerts + urgentScored.lowAlerts;
    urgentHitsAll += urgentScored.spikeHits + urgentScored.lowHits;
    urgentHits += severeScored.spikeHits + severeScored.lowHits;
    urgentTrue +=
      urgentScored.spikeAlerts -
      urgentScored.spikeFalse +
      (urgentScored.lowAlerts - urgentScored.lowFalse);
  }
  // Lead time is reported for spikes: a low's lead depends on the fixed 60-min window, not the twin.
  spikeLeads.sort((a, b) => a - b);
  const leadIqrMin: [number, number] | null = spikeLeads.length
    ? [Math.round(quantile(spikeLeads, 0.25)), Math.round(quantile(spikeLeads, 0.75))]
    : null;
  const eventN = spikeEvents + lowEvents;
  const allAlerts = spikeAlerts + lowAlerts;
  const watchAlerts = allAlerts - urgentAlerts;
  const patientDays = models.length * evalDays;
  return {
    horizons: horizonScores,
    groups,
    alerts: {
      spikeEvents,
      lowEvents,
      spikeAlerts,
      lowAlerts,
      spikeRecall: spikeEvents ? Math.round((spikeHits / spikeEvents) * 1000) / 1000 : null,
      spikePrecision: spikeAlerts ? Math.round((spikeTrue / spikeAlerts) * 1000) / 1000 : null,
      lowRecall: lowEvents ? Math.round((lowHits / lowEvents) * 1000) / 1000 : null,
      lowPrecision: lowAlerts ? Math.round((lowTrue / lowAlerts) * 1000) / 1000 : null,
      falsePerPatientDay: round2(falseAlerts / (models.length * evalDays)),
      medianLeadMin: spikeLeads.length ? Math.round(quantile(spikeLeads, 0.5)) : null,
      leadIqrMin,
      evalDays,
      spikeHits,
      lowHits,
      spikeTrue,
      lowTrue,
      urgentAlerts,
      urgentHits,
      urgentTrue,
      urgentEvents,
      urgentRecall: urgentEvents ? Math.round((urgentHits / urgentEvents) * 1000) / 1000 : null,
      urgentHitsAllEvents: urgentHitsAll,
      urgentRecallAllEvents: eventN ? Math.round((urgentHitsAll / eventN) * 1000) / 1000 : null,
      urgentPrecision: urgentAlerts ? Math.round((urgentTrue / urgentAlerts) * 1000) / 1000 : null,
      watchAlerts,
      urgentPerPatientDay: round1(urgentAlerts / patientDays),
      watchPerPatientDay: round1(watchAlerts / patientDays),
    },
    generator,
  };
}

type Draft = {
  persona: Persona;
  meals: Meal[];
  walks: Walk[];
  nights: Night[];
  readings: Reading[];
  bmi: number;
  cluster: ReturnType<typeof assignCluster>;
  /** Record prior from labs and the TCF7L2 count, shifted by the approximate cluster. */
  recordRaw: TwinKnobs;
  /** Personal fit shrunk toward the group prior only (no record). */
  groupParams: TwinParams;
};

type WardInputs = Omit<Draft, "groupParams">;

/** The cheap, deterministic part of a simulated patient: schedule, logs, CGM stream and record prior. */
function simulateInputs(persona: Persona, generator: "matched" | "mismatched"): WardInputs {
  const { meals, walks, nights } = buildSchedule(persona);
  const observed =
    generator === "mismatched"
      ? distortLogs(persona, meals, mulberry32(4200 + persona.seed * 13))
      : { visible: meals, absorbed: meals };
  const readings =
    generator === "mismatched"
      ? simulateMismatched(persona, observed.absorbed, walks, nights)
      : simulate(persona, observed.absorbed, walks, nights);
  const bmi = bmiOf(persona.heightCm, persona.weightKg);
  const cluster = assignCluster({
    hba1c: persona.hba1c,
    bmi,
    age: persona.age,
    fastingGlucose: persona.fastingGlucose,
    fastingInsulin: persona.fastingInsulin,
    triglycerides: persona.triglycerides,
    hdl: persona.hdl,
  });
  const recordRaw = applyCluster(
    seededEhrPrior(
      {
        hba1c: persona.hba1c,
        fastingGlucose: persona.fastingGlucose,
        fastingInsulin: persona.fastingInsulin,
        homaIr: homaIr(persona.fastingGlucose, persona.fastingInsulin),
        bmi,
        age: persona.age,
        sex: persona.sex,
        alleles: persona.alleles,
      },
      41000 + persona.seed,
    ),
    cluster.id,
  );
  return {
    persona,
    meals: observed.visible,
    walks,
    nights,
    readings,
    bmi,
    cluster,
    recordRaw,
  };
}

function draftPatient(persona: Persona, generator: "matched" | "mismatched"): Draft {
  const inputs = simulateInputs(persona, generator);
  const pop = POP[persona.group];
  const groupParams = chooseTrust(
    estimateParams(persona, inputs.meals, inputs.walks, inputs.nights, inputs.readings, pop),
    pop,
    inputs.meals,
    inputs.walks,
    inputs.nights,
    inputs.readings,
  );
  return { ...inputs, groupParams };
}

/**
 * Cold-start record prior, regularised: per knob, blend the record + cluster
 * map with the group prior by inverse error variance. The variances come from
 * the other patients' fitting-day estimates (leave-one-out), so a patient's own
 * data and every scored day stay out of their weight.
 */
function blendRecordPriors(drafts: Draft[]): TwinKnobs[] {
  return drafts.map((draft, i) => {
    const pop = POP[draft.persona.group];
    const blended = { ...pop };
    for (const key of KNOB_KEYS) {
      let errRecord = 0;
      let errGroup = 0;
      drafts.forEach((other, j) => {
        if (j === i) return;
        const target = other.groupParams.knobs[key];
        errRecord += (other.recordRaw[key] - target) ** 2;
        errGroup += (POP[other.persona.group][key] - target) ** 2;
      });
      const weight = errRecord + errGroup > 0 ? errGroup / (errRecord + errGroup) : 0.5;
      blended[key] = pop[key] + weight * (draft.recordRaw[key] - pop[key]);
    }
    return blended;
  });
}

function patientRecord(
  persona: Persona,
  bmi: number,
  cluster: ReturnType<typeof assignCluster>,
): Patient {
  return {
    id: persona.id,
    name: persona.name,
    age: persona.age,
    sex: persona.sex,
    group: persona.group,
    heightCm: persona.heightCm,
    weightKg: persona.weightKg,
    bmi,
    hba1c: persona.hba1c,
    hba1cHistory: persona.history.map((percent, i) => ({ when: HISTORY_WHEN[i]!, percent })),
    fastingGlucose: persona.fastingGlucose,
    fastingInsulin: persona.fastingInsulin,
    homaIr: homaIr(persona.fastingGlucose, persona.fastingInsulin),
    triglycerides: persona.triglycerides,
    hdl: persona.hdl,
    ldl: persona.ldl,
    onMetformin: persona.group === "t2d",
    alleles: persona.alleles,
    diagnoses:
      persona.group === "t2d"
        ? ["Type 2 diabetes mellitus"]
        : persona.group === "prediabetes"
          ? ["Prediabetes"]
          : [],
    meds: [
      ...(persona.group === "t2d" ? ["Metformin"] : []),
      ...(persona.drugFromDay != null
        ? ["Sulfonylurea from day 16 · simulated modelling assumption"]
        : []),
    ],
    lagSteps: persona.lagSteps,
    sulfonylureaFromDay: persona.drugFromDay ?? null,
    simulated: true,
    cluster: cluster.id,
    clusterNote: cluster.note,
  };
}

/** The live twin: personal fit shrunk toward the blended record + cluster prior. */
function finishPatient(draft: Draft, prior: TwinKnobs): PatientModel {
  const { persona, meals, walks, nights, readings, bmi, cluster } = draft;
  const medFromDay = persona.drugFromDay ?? null;
  const params = chooseTrust(
    estimateParams(persona, meals, walks, nights, readings, prior),
    prior,
    meals,
    walks,
    nights,
    readings,
    POP[persona.group],
  );
  const bands = fitBands(meals, walks, nights, readings, params.knobs, medFromDay);
  const built = buildAlerts(
    persona.id,
    readings,
    meals,
    walks,
    nights,
    params.knobs,
    bands,
    EVAL_START * STEPS_PER_DAY,
    1,
    1,
    medFromDay,
  );
  const patient = patientRecord(persona, bmi, cluster);
  const model: PatientModel = {
    patient,
    readings,
    meals,
    walks,
    nights,
    params,
    popKnobs: POP[persona.group],
    bands,
    alerts: built.alerts,
    spikeProb: built.spikeProb,
    lowProb: built.lowProb,
    active: built.active,
    fit: { rmse60: 0, rmse60Pop: 0, rmse120: 0 },
    originMs: ORIGIN_MS,
    libreOffset: null,
    ehrKnobs: prior,
    noRecordKnobs: draft.groupParams.knobs,
    alertSetup: { readyAt: EVAL_START * STEPS_PER_DAY, lowScale: 1, spikeScale: 1, lowTrend: null },
    driftStart: built.driftStart,
    driftRecovered: built.driftRecovered,
  };
  sampleCache.set(model, built.samples);
  return model;
}

/**
 * Seed offset of the calibration realization: the same eleven personas with new
 * meals, hidden snacks, sleep, walks and sensor noise. A multiple of 4 keeps the
 * seed-parity traits (sensor lag, sleep length) of each persona.
 */
export const CALIBRATION_SEED_OFFSET = 1000;

export type DrugGuardCandidate = {
  guard: DrugGuard | null;
  lowAlerts: number;
  lowHits: number;
  recall: number;
  precision: number | null;
};

export type DrugGuardCalibration = {
  seedOffset: number;
  patientId: string;
  /** 1-indexed days of the calibration realization the guard was scored on. */
  days: [number, number];
  lowEvents: number;
  rule: string;
  chosen: DrugGuard | null;
  candidates: DrugGuardCandidate[];
};

/**
 * Picks the sulfonylurea low guard on the calibration realization only: the
 * drug patient's lows on her drug days, scored with the ward's low rule
 * (highest recall with precision at least 0.8; ties go to the more
 * conservative guard). The scored seed never enters, so its test days stay
 * blind to DRUG_LOW_GUARD.
 */
/** The drug patient of the calibration realization, fitted exactly as on the scored seed. */
export function calibrationDrugPatient(): PatientModel {
  const shifted = personas().map((persona) => ({ ...persona, seed: persona.seed + CALIBRATION_SEED_OFFSET }));
  const drafts = shifted.map((persona) => draftPatient(persona, "mismatched"));
  const priors = blendRecordPriors(drafts);
  const at = drafts.findIndex((draft) => draft.persona.drugFromDay != null);
  return finishPatient(drafts[at]!, priors[at]!);
}

export function calibrateDrugGuard(): DrugGuardCalibration {
  const model = calibrationDrugPatient();
  const fromDay = model.patient.sulfonylureaFromDay!;
  const from = fromDay * STEPS_PER_DAY;
  const lows = glucoseEventsOf(model).lows.filter((index) => index >= from);
  const grid: (DrugGuard | null)[] = [null];
  for (const minGap of [150, 180, 210, 240])
    for (const maxGlucose of [105, 110, 115, 120])
      for (const fallRate of [-0.6, -0.8, -1.0]) grid.push({ minGap, maxGlucose, fallRate, withinMin: 60 });
  const candidates = grid.map((guard): DrugGuardCandidate => {
    const built = buildAlerts(
      model.patient.id,
      model.readings,
      model.meals,
      model.walks,
      model.nights,
      model.params.knobs,
      model.bands,
      EVAL_START * STEPS_PER_DAY,
      1,
      1,
      fromDay,
      null,
      undefined,
      undefined,
      guard,
    );
    const marks = built.alerts
      .filter((alert) => alert.kind === "low" && alert.index >= from)
      .map((alert) => ({ index: alert.index, kind: alert.kind }));
    const scored = scoreAlertEvents([], lows, marks, STEP_MIN);
    return {
      guard,
      lowAlerts: scored.lowAlerts,
      lowHits: scored.lowHits,
      recall: lows.length ? round3(scored.lowHits / lows.length) : 0,
      precision: scored.lowAlerts ? round3((scored.lowAlerts - scored.lowFalse) / scored.lowAlerts) : null,
    };
  });
  const conservative = (a: DrugGuardCandidate, b: DrugGuardCandidate): number =>
    (b.precision ?? 0) - (a.precision ?? 0) ||
    (b.guard?.minGap ?? 1e9) - (a.guard?.minGap ?? 1e9) ||
    (a.guard?.maxGlucose ?? 0) - (b.guard?.maxGlucose ?? 0) ||
    (a.guard?.fallRate ?? -1e9) - (b.guard?.fallRate ?? -1e9);
  const f1 = (row: DrugGuardCandidate): number => {
    const precision = row.precision ?? 0;
    return row.recall + precision > 0 ? (2 * row.recall * precision) / (row.recall + precision) : 0;
  };
  const safe = candidates.filter((row) => (row.precision ?? 0) >= 0.8);
  const best = safe.length
    ? [...safe].sort((a, b) => b.recall - a.recall || conservative(a, b))[0]!
    : [...candidates].sort((a, b) => f1(b) - f1(a) || conservative(a, b))[0]!;
  return {
    seedOffset: CALIBRATION_SEED_OFFSET,
    patientId: model.patient.id,
    days: [fromDay + 1, DAYS],
    lowEvents: lows.length,
    rule: "highest low recall with precision at least 0.8, else best F1; ties to higher precision, later start, lower ceiling, steeper fall",
    chosen: best.guard,
    candidates,
  };
}

function buildWard(generator: "matched" | "mismatched"): PatientModel[] {
  const drafts = personas().map((persona) => draftPatient(persona, generator));
  const priors = blendRecordPriors(drafts);
  return drafts.map((draft, i) => finishPatient(draft, priors[i]!));
}

export function materializeSeries(input: {
  patient: Patient;
  readings: Reading[];
  meals: Meal[];
  walks: Walk[];
  nights: Night[];
  knobs: TwinKnobs;
  popKnobs: TwinKnobs;
  bands: Record<30 | 60 | 120, BandOffset>;
  originMs: number;
  libreOffset: number | null;
  ehrKnobs: TwinKnobs;
  fit: { rmse60: number; rmse60Pop: number; rmse120: number };
  isolatedMeals: number;
  calibration?: Calibration;
  /** Knobs without the record prior (defaults to knobs). */
  noRecordKnobs?: TwinKnobs;
  trend?: TrendCorrection;
  personalTrust?: number;
  /** Real data only: the CGM trend rule for lows picked on validation days (real_eval.json lowRule). */
  lowTrend?: LowTrendRule | null;
}): PatientModel {
  const found = input.readings.findIndex((_, index) => Math.floor((index * STEP_MIN) / 1440) >= 6);
  const readyAt = found < 0 ? input.readings.length : found;
  const built = buildAlerts(
    input.patient.id,
    input.readings,
    input.meals,
    input.walks,
    input.nights,
    input.knobs,
    input.bands,
    readyAt,
    1,
    1,
    null,
    input.lowTrend ?? null,
  );
  return {
    patient: input.patient,
    readings: input.readings,
    meals: input.meals,
    walks: input.walks,
    nights: input.nights,
    params: {
      carbSensitivity: input.knobs.carbSensitivity,
      activityEffect: input.knobs.activityEffect,
      fastingBaseline: input.knobs.fastingBaseline,
      recoveryMin: null,
      isolatedMeals: input.isolatedMeals,
      personalTrust: input.personalTrust ?? 1,
      knobs: input.knobs,
      calibration: input.calibration ?? {
        carbMean: null,
        carbN: 0,
        actMean: null,
        actN: 0,
        fastingMedian: input.knobs.fastingBaseline,
      },
    },
    popKnobs: input.popKnobs,
    bands: input.bands,
    alerts: built.alerts,
    spikeProb: built.spikeProb,
    lowProb: built.lowProb,
    active: built.active,
    fit: input.fit,
    originMs: input.originMs,
    libreOffset: input.libreOffset,
    ehrKnobs: input.ehrKnobs,
    noRecordKnobs: input.noRecordKnobs ?? input.knobs,
    ...(input.trend ? { trend: input.trend } : {}),
    alertSetup: { readyAt, lowScale: 1, spikeScale: 1, lowTrend: input.lowTrend ?? null },
    driftStart: built.driftStart,
    driftRecovered: built.driftRecovered,
  };
}

function pooledRmse60(
  models: PatientModel[],
  knobsFor: (model: PatientModel) => TwinKnobs,
  mask?: { meals?: boolean; walks?: boolean; sleep?: boolean },
  only?: (model: PatientModel, index: number) => boolean,
  digits = 1,
  withMedicine = true,
): { rmse60: number; n: number } {
  let sse = 0;
  let n = 0;
  for (const model of models) {
    const knobs = knobsFor(model);
    const medFromDay = withMedicine ? (model.patient.sulfonylureaFromDay ?? null) : null;
    for (let day = EVAL_START; day < DAYS; day += 1) {
      for (let slot = 0; slot < STEPS_PER_DAY; slot += 6) {
        const index = day * STEPS_PER_DAY + slot;
        if (only && !only(model, index)) continue;
        const actual = glucoseAt(model.readings, index + 12);
        const pred = pointForecast(
          index,
          12,
          model.readings,
          model.meals,
          model.walks,
          model.nights,
          knobs,
          mask,
          medFromDay,
        );
        if (actual == null || pred == null) continue;
        sse += (pred - actual) ** 2;
        n += 1;
      }
    }
  }
  const value = n ? Math.sqrt(sse / n) : 0;
  return { rmse60: Math.round(value * 10 ** digits) / 10 ** digits, n };
}

/** After a short (< 6.5 h), inefficient (< 85%) or HRV-stressed (> 15% below baseline) night. */
function afterHardNight(model: PatientModel, index: number): boolean {
  const night = model.nights[dayOfIndex(index)];
  if (!night) return false;
  const base = hrvBaseline(model.nights);
  const hrvDrop = base > 0 && night.rmssd > 0 ? (base - night.rmssd) / base : 0;
  return (
    night.durationH < 6.5 || (night.efficiency > 0 && night.efficiency < 0.85) || hrvDrop > 0.15
  );
}

/** Within 2 h after a logged meal, on a day after a short or stressed night. */
function afterHardNightMeal(model: PatientModel, index: number): boolean {
  if (!afterHardNight(model, index)) return false;
  const nowMin = index * STEP_MIN;
  return model.meals.some(
    (meal) => meal.logged && meal.carbs >= 8 && nowMin >= meal.min && nowMin - meal.min <= 120,
  );
}

/** Within 6 h after a logged walk ends. */
function afterWalk(model: PatientModel, index: number): boolean {
  const nowMin = index * STEP_MIN;
  return model.walks.some(
    (walk) => walk.logged && nowMin >= walk.min && nowMin - (walk.min + walk.durationMin) < 360,
  );
}

function buildAblation(models: PatientModel[]): AblationArm[] {
  // The medication list is part of the record, so arms without it drop the medicine term.
  const none = pooledRmse60(models, () => globalKnobs(), undefined, undefined, 1, false);
  const group = pooledRmse60(models, (model) => model.popKnobs, undefined, undefined, 1, false);
  const ehr = pooledRmse60(models, (model) => model.ehrKnobs);
  // The live twin: personal CGM fit shrunk toward the blended record + cluster prior.
  const both = pooledRmse60(models, (model) => model.params.knobs);
  return [
    { id: "none", label: "No EHR", rmse60: none.rmse60, n: none.n },
    { id: "group", label: "Group only", rmse60: group.rmse60, n: group.n },
    { id: "ehr", label: "Record + cluster", rmse60: ehr.rmse60, n: ehr.n },
    {
      id: "ehrPersonal",
      label: "Record + cluster + personal calibration",
      rmse60: both.rmse60,
      n: both.n,
    },
  ];
}

/**
 * Spike F1, low recall and Urgent recall on days 10–21 with alerts rebuilt for
 * one stream arm: the arm's knobs, stream mask and medicine term, no cached
 * samples. Thresholds and bands are the live twin's. Events are the same
 * ground truth for every arm.
 */
function armAlertScore(
  models: PatientModel[],
  knobsFor: (model: PatientModel) => TwinKnobs,
  options: {
    mask?: { sleep?: boolean; walks?: boolean };
    noMeals?: boolean;
    withMedicine?: boolean;
    live?: boolean;
  } = {},
): ArmAlertScore {
  const from = EVAL_START * STEPS_PER_DAY;
  let spikeEvents = 0;
  let spikeHits = 0;
  let spikeAlerts = 0;
  let spikeFalse = 0;
  let lowHits = 0;
  let lowEvents = 0;
  let urgentHits = 0;
  let urgentEvents = 0;
  for (const model of models) {
    const alertsFor = options.live
      ? model.alerts
      : buildAlerts(
          model.patient.id,
          model.readings,
          options.noMeals ? [] : model.meals,
          model.walks,
          model.nights,
          knobsFor(model),
          model.bands,
          model.alertSetup.readyAt,
          model.alertSetup.lowScale,
          model.alertSetup.spikeScale,
          options.withMedicine === false ? null : (model.patient.sulfonylureaFromDay ?? null),
          null,
          undefined,
          options.mask,
        ).alerts;
    const found = glucoseEventsOf(model);
    const spikes = found.spikes.filter((index) => index >= from);
    const lows = found.lows.filter((index) => index >= from);
    const marks = alertsFor
      .filter((alert) => alert.index >= from)
      .map((alert) => ({ index: alert.index, kind: alert.kind }));
    const scored = scoreAlertEvents(spikes, lows, marks, STEP_MIN);
    spikeEvents += scored.spikeEvents;
    spikeHits += scored.spikeHits;
    spikeAlerts += scored.spikeAlerts;
    spikeFalse += scored.spikeFalse;
    lowHits += scored.lowHits;
    lowEvents += scored.lowEvents;
    const urgent = alertsFor
      .filter((alert) => alert.severity === "urgent" && (alert.urgentAt ?? alert.index) >= from)
      .map((alert) => ({ index: alert.urgentAt ?? alert.index, kind: alert.kind }));
    const severeSpikes = spikes.filter((index) => severeSpike(model.readings, index));
    const severe = scoreAlertEvents(severeSpikes, lows, urgent, STEP_MIN);
    urgentHits += severe.spikeHits + severe.lowHits;
    urgentEvents += severeSpikes.length + lows.length;
  }
  const recall = spikeEvents ? spikeHits / spikeEvents : 0;
  const precision = spikeAlerts ? (spikeAlerts - spikeFalse) / spikeAlerts : 0;
  return {
    spikeF1: recall + precision > 0 ? round3((2 * recall * precision) / (recall + precision)) : null,
    lowHits,
    lowEvents,
    lowRecall: lowEvents ? round3(lowHits / lowEvents) : null,
    urgentHits,
    urgentEvents,
    urgentRecall: urgentEvents ? round3(urgentHits / urgentEvents) : null,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function buildStreamAblation(models: PatientModel[]): AblationArm[] {
  const knobs = (model: PatientModel) => model.params.knobs;
  const full = pooledRmse60(models, knobs, undefined, undefined, 2);
  const noRecord = pooledRmse60(
    models,
    (model) => model.noRecordKnobs,
    undefined,
    undefined,
    2,
    false,
  );
  const noRecordNoPersonal = pooledRmse60(
    models,
    (model) => model.popKnobs,
    undefined,
    undefined,
    2,
    false,
  );
  const noMeals = pooledRmse60(models, knobs, { meals: false }, undefined, 2);
  const noActivity = pooledRmse60(models, knobs, { walks: false }, undefined, 2);
  const noSleep = pooledRmse60(models, knobs, { sleep: false }, undefined, 2);
  const fullNight = pooledRmse60(models, knobs, undefined, afterHardNight, 2);
  const noSleepNight = pooledRmse60(models, knobs, { sleep: false }, afterHardNight, 2);
  const fullNightMeal = pooledRmse60(models, knobs, undefined, afterHardNightMeal, 2);
  const noSleepNightMeal = pooledRmse60(models, knobs, { sleep: false }, afterHardNightMeal, 2);
  const fullWalk = pooledRmse60(models, knobs, undefined, afterWalk, 2);
  const noActivityWalk = pooledRmse60(models, knobs, { walks: false }, afterWalk, 2);
  return [
    {
      id: "full",
      label: "All streams",
      rmse60: full.rmse60,
      n: full.n,
      alerts: armAlertScore(models, knobs, { live: true }),
    },
    {
      id: "noRecord",
      label: "No record (group prior + personal fit, no medicine term)",
      rmse60: noRecord.rmse60,
      n: noRecord.n,
      alerts: armAlertScore(models, (model) => model.noRecordKnobs, { withMedicine: false }),
    },
    {
      id: "noRecordNoPersonal",
      label: "No record and no personal fit (group prior only)",
      rmse60: noRecordNoPersonal.rmse60,
      n: noRecordNoPersonal.n,
      alerts: armAlertScore(models, (model) => model.popKnobs, { withMedicine: false }),
    },
    {
      id: "noMeals",
      label: "No meals",
      rmse60: noMeals.rmse60,
      n: noMeals.n,
      alerts: armAlertScore(models, knobs, { noMeals: true }),
    },
    {
      id: "noActivity",
      label: "No activity",
      rmse60: noActivity.rmse60,
      n: noActivity.n,
      alerts: armAlertScore(models, knobs, { mask: { walks: false } }),
    },
    {
      id: "noSleep",
      label: "No sleep or HRV",
      rmse60: noSleep.rmse60,
      n: noSleep.n,
      alerts: armAlertScore(models, knobs, { mask: { sleep: false } }),
    },
    {
      id: "fullHardNight",
      label: "All streams, days after a short or stressed night",
      rmse60: fullNight.rmse60,
      n: fullNight.n,
    },
    {
      id: "noSleepHardNight",
      label: "No sleep or HRV, days after a short or stressed night",
      rmse60: noSleepNight.rmse60,
      n: noSleepNight.n,
    },
    {
      id: "fullHardNightMeal",
      label: "All streams, 2 h after a meal following a short or stressed night",
      rmse60: fullNightMeal.rmse60,
      n: fullNightMeal.n,
    },
    {
      id: "noSleepHardNightMeal",
      label: "No sleep or HRV, 2 h after a meal following a short or stressed night",
      rmse60: noSleepNightMeal.rmse60,
      n: noSleepNightMeal.n,
    },
    {
      id: "fullAfterWalk",
      label: "All streams, 6 h after a walk",
      rmse60: fullWalk.rmse60,
      n: fullWalk.n,
    },
    {
      id: "noActivityAfterWalk",
      label: "No activity, 6 h after a walk",
      rmse60: noActivityWalk.rmse60,
      n: noActivityWalk.n,
    },
  ];
}

function lowCostRmse(models: PatientModel[]): { pricks: number; rmse: number }[] {
  const counts = [2, 4, 6, 8] as const;
  const from = EVAL_START * STEPS_PER_DAY;
  const rows = counts.map((pricks) => {
    const truth: Array<number | null> = [];
    const filledAll: Array<number | null> = [];
    for (const model of models) {
      const series = model.readings.map((reading) =>
        reading.cgmGap || reading.compressionLow ? null : reading.glucose,
      );
      const filled = interpolatePricks(series, STEP_MIN, prickClocks(pricks));
      truth.push(...series.slice(from));
      filledAll.push(...filled.slice(from));
    }
    return { pricks, rmse: round1(maskedRmse(truth, filledAll)) };
  });
  return [...rows, { pricks: 288, rmse: 0 }];
}

function medianClock(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

export function usualMeal(
  model: PatientModel,
  nowMin: number,
): {
  carbs: number;
  fiber: number;
  protein: number;
  fat: number;
  name: string;
  atMin: number;
} | null {
  const usual = usualMealFrom(model.meals, nowMin);
  if (!usual) return null;
  return {
    carbs: usual.carbs,
    fiber: usual.fiber,
    protein: usual.protein,
    fat: usual.fat,
    name: usual.name,
    atMin: usual.atMin,
  };
}

function habitScore(models: PatientModel[]): {
  medianLeadMin: number | null;
  spikeRecall: number | null;
} {
  let spikeEvents = 0;
  let spikeHits = 0;
  const leads: number[] = [];
  const from = EVAL_START * STEPS_PER_DAY;
  for (const model of models) {
    const samples = model.readings.map((reading, index) => {
      const blocked =
        !reading ||
        reading.glucose == null ||
        reading.cgmGap ||
        reading.compressionLow ||
        reading.cgmCensored;
      if (blocked || reading.glucose == null || index < from)
        return { spike: 0, low: 0, gap: true, day: dayOfIndex(index) };
      const nowMin = index * STEP_MIN;
      const meals = loggedMealsUntil(model.meals, nowMin);
      const usual = usualMeal(model, nowMin);
      if (usual)
        meals.push({
          min: usual.atMin,
          carbs: usual.carbs,
          fiber: usual.fiber,
          protein: usual.protein,
          fat: usual.fat,
          name: usual.name,
        });
      const curve = project({
        nowMin,
        glucoseNow: reading.glucose,
        meals,
        walks: loggedWalksUntil(model.walks, nowMin),
        knobs: wearableKnobs(
          model.params.knobs,
          model.nights,
          dayOfIndex(index),
          nowMin,
          loggedWalksUntil(model.walks, nowMin),
        ),
        bands: model.bands,
      });
      return {
        spike: spikeProbability(reading.glucose, curve),
        low: 0,
        gap: false,
        day: dayOfIndex(index),
      };
    });
    const fires = hygieneFires(samples);
    const alerts = fires.flatMap((kind, index) =>
      kind === "spike" && index >= from ? [{ index, kind: "spike" as const }] : [],
    );
    const spikes = glucoseEventsOf(model).spikes.filter((index) => index >= from);
    const scored = scoreAlertEvents(spikes, [], alerts, STEP_MIN);
    spikeEvents += scored.spikeEvents;
    spikeHits += scored.spikeHits;
    leads.push(...scored.leads);
  }
  leads.sort((a, b) => a - b);
  return {
    medianLeadMin: leads.length ? Math.round(quantile(leads, 0.5)) : null,
    spikeRecall: spikeEvents ? Math.round((spikeHits / spikeEvents) * 1000) / 1000 : null,
  };
}

function findCue(
  model: PatientModel,
  kind: "spike" | "low",
  day: number,
  minuteRange?: [number, number],
): number | null {
  const alerts = model.alerts.filter(
    (item) => item.kind === kind && dayOfIndex(item.index) === day,
  );
  if (minuteRange) {
    const preferred = alerts.find((item) => {
      const minute = (item.index * STEP_MIN) % 1440;
      return minute >= minuteRange[0] && minute <= minuteRange[1];
    });
    if (preferred) return preferred.index;
  }
  return alerts[0]?.index ?? model.alerts.find((item) => item.kind === kind)?.index ?? null;
}

const THRESHOLDS: Record<"spike" | "low", number[]> = {
  spike: [0.6, 0.7, 0.8, 0.9],
  low: [0.6, 0.5, 0.4, 0.3, 0.2],
};

/**
 * Alert threshold chosen on the validation days (5–8), pooled over the ward;
 * the scored days are never used. Spikes: best event F1. Lows: the highest
 * recall whose precision is at least 0.8, else best F1. The first listed
 * threshold wins ties. Returned as the scale that maps it onto the hygiene rule's 0.6 / 0.4
 * hysteresis.
 */
function chooseScale(models: PatientModel[], kind: "spike" | "low"): number {
  const from = PARAM_DAYS * STEPS_PER_DAY;
  const to = CONF_END * STEPS_PER_DAY;
  let best = { scale: 1, f1: -1 };
  let safest: { scale: number; recall: number } | null = null;
  for (const threshold of THRESHOLDS[kind]) {
    const scale = 0.6 / threshold;
    let events = 0;
    let hits = 0;
    let alerts = 0;
    let falses = 0;
    for (const model of models) {
      const prob = kind === "spike" ? model.spikeProb : model.lowProb;
      const fires = hygieneFires(
        model.readings.map((reading, index) => ({
          spike: kind === "spike" ? Math.min(1, prob[index]! * scale) : 0,
          low: kind === "low" ? Math.min(1, prob[index]! * scale) : 0,
          gap:
            !reading ||
            reading.glucose == null ||
            reading.cgmGap ||
            reading.compressionLow ||
            reading.cgmCensored,
          day: dayOfIndex(index),
        })),
      );
      const marks = fires.flatMap((fired, index) =>
        fired === kind && index >= from && index < to ? [{ index, kind }] : [],
      );
      const found = glucoseEventsOf(model);
      const spikes =
        kind === "spike" ? found.spikes.filter((index) => index >= from && index < to) : [];
      const lows = kind === "low" ? found.lows.filter((index) => index >= from && index < to) : [];
      const scored = scoreAlertEvents(spikes, lows, marks, STEP_MIN);
      events += kind === "spike" ? scored.spikeEvents : scored.lowEvents;
      hits += kind === "spike" ? scored.spikeHits : scored.lowHits;
      alerts += kind === "spike" ? scored.spikeAlerts : scored.lowAlerts;
      falses += kind === "spike" ? scored.spikeFalse : scored.lowFalse;
    }
    const recall = events ? hits / events : 0;
    const precision = alerts ? (alerts - falses) / alerts : 0;
    const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;
    if (f1 > best.f1 + 1e-9) best = { scale, f1 };
    if (kind === "low" && alerts > 0 && precision >= 0.8 && recall > (safest?.recall ?? -1) + 1e-9)
      safest = { scale, recall };
  }
  return safest?.scale ?? best.scale;
}

function rebuildAlerts(models: PatientModel[], lowScale: number, spikeScale: number): void {
  if (lowScale === 1 && spikeScale === 1) return;
  for (const model of models) {
    const built = buildAlerts(
      model.patient.id,
      model.readings,
      model.meals,
      model.walks,
      model.nights,
      model.params.knobs,
      model.bands,
      EVAL_START * STEPS_PER_DAY,
      lowScale,
      spikeScale,
      model.patient.sulfonylureaFromDay ?? null,
      null,
      sampleCache.get(model),
    );
    model.alerts = built.alerts;
    model.alertSetup = { ...model.alertSetup, lowScale, spikeScale };
    model.spikeProb = built.spikeProb;
    model.lowProb = built.lowProb;
    model.active = built.active;
    model.driftStart = built.driftStart;
    model.driftRecovered = built.driftRecovered;
  }
}

const KNOB_KEYS = [
  "carbSensitivity",
  "activityEffect",
  "fastingBaseline",
  "dawnAmp",
  "tauMin",
] as const;


/** The simulated ward the app shows: fitted twins, alerts, fit and demo cues. No cohort evaluation. */
export type SimWard = {
  patients: PatientModel[];
  demoIndex: number;
  cues: Cue[];
  trainingMaxCarbs: number;
  seriesLength: number;
  originMs: number;
  lowScale: number;
  spikeScale: number;
};

function buildSimWard(): SimWard {
  const models = buildWard("mismatched");
  let trainingMax = 20;
  for (const model of models) {
    for (const meal of model.meals) {
      if (meal.logged && meal.min < CONF_END * 1440)
        trainingMax = Math.max(trainingMax, meal.carbs);
    }
  }
  const lowScale = chooseScale(models, "low");
  const spikeScale = chooseScale(models, "spike");
  rebuildAlerts(models, lowScale, spikeScale);
  for (const model of models) scoreModel(model);
  const ananya = models.find((model) => model.patient.id === "GT-07")!;
  const kavita = models.find((model) => model.patient.id === "GT-03")!;
  const spikeIndex =
    findCue(ananya, "spike", 14, [12 * 60, 15 * 60]) ??
    14 * STEPS_PER_DAY + Math.round((13 * 60) / STEP_MIN);
  const lowIndex =
    findCue(kavita, "low", 14, [20 * 60, 23 * 60]) ??
    14 * STEPS_PER_DAY + Math.round((21 * 60) / STEP_MIN);
  const cues: Cue[] = [
    { id: "spike", label: "Spike window · Ananya", patientId: "GT-07", index: spikeIndex },
    { id: "low", label: "Low window · Kavita", patientId: "GT-03", index: lowIndex },
    {
      id: "fasting",
      label: "Morning · Rohan",
      patientId: "GT-02",
      index: 14 * STEPS_PER_DAY + Math.round((7 * 60) / STEP_MIN),
    },
    {
      id: "snack",
      label: "Unlogged snack · Ananya",
      patientId: "GT-07",
      index: 13 * STEPS_PER_DAY + Math.round((16 * 60 + 50) / STEP_MIN),
      tab: "split",
    },
    {
      id: "gap",
      label: "Sensor gap · Vikram",
      patientId: "GT-12",
      index: 4 * STEPS_PER_DAY + Math.round((11 * 60 + 20) / STEP_MIN),
      tab: "split",
    },
    {
      id: "dawn",
      label: "Dawn · Fatima",
      patientId: "GT-19",
      index: 14 * STEPS_PER_DAY + Math.round((8 * 60) / STEP_MIN),
      tab: "night",
    },
  ];
  const day15 = 15 * STEPS_PER_DAY;
  const drifted =
    models.find((model) => model.driftStart != null && model.driftStart >= day15) ??
    models.find((model) => model.driftStart != null);
  if (drifted?.driftStart != null) {
    cues.push({
      id: "drift",
      label: `Drift · ${drifted.patient.name}`,
      patientId: drifted.patient.id,
      index: drifted.driftStart,
    });
  }
  return {
    patients: models,
    demoIndex: spikeIndex,
    cues,
    trainingMaxCarbs: round1(trainingMax),
    seriesLength: SERIES_LEN,
    originMs: ORIGIN_MS,
    lowScale,
    spikeScale,
  };
}

let wardCached: SimWard | null = null;

/** The light simulated ward (about 3 s to build; the app loads its snapshot instead). */
export function getSimWard(): SimWard {
  if (!wardCached) wardCached = buildSimWard();
  return wardCached;
}

/** The full cohort: the ward plus the matched ward, evaluations and ablations. Scripts and tests. */
function buildCohort(): Cohort {
  const ward = getSimWard();
  const models = ward.patients;
  const matched = buildWard("matched");
  rebuildAlerts(matched, ward.lowScale, ward.spikeScale);
  const evalResult = buildEval(models, "mismatched");
  const evalMatched = buildEval(matched, "matched");
  const ablation = buildAblation(models);
  const streamAblation = buildStreamAblation(models);
  const lowCost = lowCostRmse(models);
  const habit = habitScore(models);
  const mealResidual = chooseMealResidual(models);
  return {
    patients: models,
    demoIndex: ward.demoIndex,
    cues: ward.cues,
    trainingMaxCarbs: ward.trainingMaxCarbs,
    eval: evalResult,
    evalMatched,
    ablation,
    streamAblation,
    lowCost,
    habitLeadMin: habit.medianLeadMin,
    habitRecall: habit.spikeRecall,
    mealResidual,
    generator: "mismatched",
    originMs: ORIGIN_MS,
    seriesLength: SERIES_LEN,
  };
}

let cached: Cohort | null = null;

export function getCohort(): Cohort {
  if (!cached) cached = buildCohort();
  return cached;
}

export function indexToMs(index: number): number {
  return ORIGIN_MS + index * STEP_MIN * 60_000;
}

export function availableIndex(model: PatientModel, wardIndex: number): number {
  const last = Math.max(0, model.readings.length - 1);
  return Math.max(0, Math.min(last, wardIndex - model.patient.lagSteps));
}

export function clockMs(model: PatientModel, index: number): number {
  return model.originMs + index * STEP_MIN * 60_000;
}

export function isStreamStale(model: PatientModel, wardIndex: number): boolean {
  return (wardIndex - availableIndex(model, wardIndex)) * STEP_MIN > 15;
}

/**
 * Band widening when a stream is withdrawn: the record widens it by this
 * patient's group-prior to personal error ratio; wearables by a fixed 10%
 * (a modelling assumption).
 */
export function consentBands(
  model: PatientModel,
  recordOk: boolean,
  wearableOk: boolean,
): Record<30 | 60 | 120, BandOffset> {
  // At least ×1.12, so withdrawing the record always widens the band, even at personal trust 0.
  const ratio =
    model.fit.rmse60 > 0 ? Math.max(1.12, model.fit.rmse60Pop / model.fit.rmse60) : 1.12;
  const factor = (recordOk ? 1 : ratio) * (wearableOk ? 1 : 1.1);
  // Real files show the trend-corrected centre, so they use the band refit after the correction.
  const bands = model.trend?.bands ?? model.bands;
  if (factor === 1) return bands;
  const scale = (band: BandOffset): BandOffset => ({
    q10: band.q10 * factor,
    q90: band.q90 * factor,
  });
  return { 30: scale(bands[30]), 60: scale(bands[60]), 120: scale(bands[120]) };
}

export function forecastAt(
  model: PatientModel,
  index: number,
  edit?: WhatIfEdit,
): CurvePoint[] | null {
  if (model.consentOf) {
    return forecastAt(model.consentOf.base, index, {
      ...edit,
      consent: edit?.consent ?? model.consentOf.consent,
    });
  }
  if (index < 0 || index >= model.readings.length) return null;
  const reading = model.readings[index];
  if (!reading || reading.glucose == null || reading.cgmGap || reading.compressionLow) return null;
  const nowMin = index * STEP_MIN;
  const day = dayOfIndex(index);
  const meals = loggedMealsUntil(model.meals, nowMin);
  const wearableOk = edit?.consent?.wearable !== false;
  const recordOk = edit?.consent?.ehr !== false;
  const walks = wearableOk ? loggedWalksUntil(model.walks, nowMin) : [];
  if (edit?.meal) {
    if ("items" in edit.meal) {
      const summed = sumMacros(edit.meal.items);
      if (summed.unresolved.length) return null;
      if (summed.macros.carbs > 0) {
        meals.push({
          min: nowMin + edit.meal.inMin,
          ...summed.macros,
          name: describeItems(edit.meal.items),
        });
      }
    } else if (edit.meal.carbs > 0) {
      meals.push({
        min: nowMin + edit.meal.inMin,
        carbs: edit.meal.carbs,
        fiber: edit.meal.fiber,
        protein: edit.meal.protein,
        fat: edit.meal.fat,
        name: edit.meal.name,
      });
    }
  }
  if (edit?.includeUnlogged) {
    for (const meal of model.meals) {
      if (!meal.logged && meal.min <= nowMin && nowMin - meal.min < 180) meals.push(meal);
    }
  }
  if (edit?.walk && edit.walk.durationMin > 0) {
    walks.push({ min: nowMin + edit.walk.inMin, durationMin: edit.walk.durationMin });
  }
  return project({
    // The medication list comes from the health record, so it is dropped with the record's consent.
    medFromDay: recordOk ? (model.patient.sulfonylureaFromDay ?? null) : null,
    nowMin,
    glucoseNow: reading.glucose,
    meals,
    walks,
    knobs: wearableKnobs(
      recordOk ? model.params.knobs : model.noRecordKnobs,
      model.nights,
      day,
      nowMin,
      walks,
      wearableOk ? undefined : { sleep: false, walks: false },
      edit?.sleepHours ?? undefined,
    ),
    bands: consentBands(model, recordOk, wearableOk),
    horizonMin: edit?.horizonMin ?? 120,
    trend: model.trend ? { coef: model.trend.coef, slope: slope30(model.readings, index) } : undefined,
  });
}

/** CGM slope over the last 30 min in mg/dL per minute (0 when the earlier reading is missing). */
function slope30(readings: Reading[], index: number): number {
  const now = glucoseAt(readings, index);
  const before = glucoseAt(readings, index - 30 / STEP_MIN);
  return now == null || before == null ? 0 : (now - before) / 30;
}

function emptyMarks(): StreamMarks {
  return { gapMin: 0, compressionMin: 0, offWristMin: 0, sharpJumps: 0 };
}

function marksBetween(readings: Reading[], from: number, to: number): StreamMarks {
  const marks = emptyMarks();
  const start = Math.max(0, from);
  const end = Math.min(readings.length - 1, to);
  for (let index = start; index <= end; index += 1) {
    const reading = readings[index];
    if (!reading) continue;
    if (reading.cgmGap) marks.gapMin += STEP_MIN;
    if (reading.compressionLow) marks.compressionMin += STEP_MIN;
    if (!reading.worn) marks.offWristMin += STEP_MIN;
    if (reading.cgmNoise) marks.sharpJumps += 1;
  }
  return marks;
}

export function traceNow(model: PatientModel, index: number): TraceNow | null {
  if (index < 0 || index >= model.readings.length) return null;
  const reading = model.readings[index];
  const nowMin = index * STEP_MIN;
  const day = dayOfIndex(index);
  const night = model.nights[day];
  const sleepHours = night?.durationH ?? 7;
  const sleepScale =
    Math.round(
      wearableSensitivity(
        nightOf(model.nights, day),
        hrvBaseline(model.nights),
        prevNightOf(model.nights, day),
      ) * 100,
    ) / 100;
  const knobs = wearableKnobs(
    model.params.knobs,
    model.nights,
    day,
    nowMin,
    loggedWalksUntil(model.walks, nowMin),
  );
  const dayStart = day * STEPS_PER_DAY;
  const recent = marksBetween(model.readings, index - 72, index);
  const today = marksBetween(model.readings, dayStart, index);
  const unlogged: TraceContributor[] = [];
  for (const meal of model.meals) {
    if (meal.logged || meal.min > nowMin || nowMin - meal.min >= 180) continue;
    const mgdl = mealOffset(nowMin - meal.min, meal.carbs, meal.fiber, knobs.carbSensitivity);
    if (Math.abs(mgdl) < 0.4) continue;
    unlogged.push({
      id: meal.id,
      kind: "unlogged",
      label: meal.name,
      detail: `${Math.round(meal.carbs)} g carbs · ${Math.round(nowMin - meal.min)} min ago · not logged`,
      mgdl,
    });
  }
  const blocked: TraceNow["blocked"] =
    !reading || reading.glucose == null
      ? reading?.cgmGap
        ? "gap"
        : "missing"
      : reading.compressionLow
        ? "compression"
        : reading.cgmGap
          ? "gap"
          : null;
  const base: TraceNow = {
    blocked,
    glucose: blocked ? null : reading!.glucose,
    contributors: [],
    unlogged,
    recent,
    today,
    tauMin: knobs.tauMin,
    dawnMgdl: dawnRise(nowMin, knobs.dawnAmp),
    sleepHours,
    sleepScale,
  };
  if (blocked || reading?.glucose == null) return base;

  const contributors: TraceContributor[] = [];
  let accounted = 0;
  const level = circadian(nowMin, knobs.dawnAmp, knobs.fastingBaseline);
  contributors.push({
    id: "circadian",
    kind: "circadian",
    label: "Circadian baseline",
    detail: `Fasting ${Math.round(knobs.fastingBaseline)} mg/dL plus dawn and the day wave`,
    mgdl: level,
  });
  accounted += level;
  for (const meal of model.meals) {
    if (!meal.logged || meal.min > nowMin || nowMin - meal.min >= 180) continue;
    const mgdl = mealOffset(nowMin - meal.min, meal.carbs, meal.fiber, knobs.carbSensitivity);
    if (Math.abs(mgdl) < 0.4) continue;
    contributors.push({
      id: meal.id,
      kind: "meal",
      label: meal.name,
      detail: `${Math.round(meal.carbs)} g carbs · ${Math.round(nowMin - meal.min)} min ago · logged`,
      mgdl,
    });
    accounted += mgdl;
  }
  for (const walk of model.walks) {
    if (!walk.logged || walk.min > nowMin) continue;
    const delay = nowMin - walk.min;
    if (delay > walk.durationMin + 75) continue;
    const mgdl = walkOffset(delay, walk.durationMin, knobs.activityEffect);
    if (Math.abs(mgdl) < 0.4) continue;
    contributors.push({
      id: `walk-${walk.min}`,
      kind: "walk",
      label: "Walk",
      detail: `${Math.round(walk.durationMin)} min · started ${Math.round(delay)} min ago`,
      mgdl,
    });
    accounted += mgdl;
  }
  contributors.push({
    id: "residual",
    kind: "residual",
    label: "Unexplained residual",
    detail: `Fades with a ${Math.round(knobs.tauMin)} min time constant. Noise, unlogged food, and anything else the curve does not name.`,
    mgdl: reading.glucose - accounted,
  });
  return { ...base, contributors };
}

const NIGHT_END_MIN = 8 * 60;

export type NightRow = {
  dayIndex: number;
  partial: boolean;
  sleepHours: number;
  short: boolean;
  at4: number | null;
  at8: number | null;
  rise: number | null;
  nadir: number | null;
  below70Min: number;
  above180Min: number;
  gapMin: number;
  compressionMin: number;
};

export type NightBin = {
  minute: number;
  p25: number;
  p50: number;
  p75: number;
  last: number | null;
};

export type NightReview = {
  rows: NightRow[];
  bins: NightBin[];
  medianRise: number | null;
};

function nearestGlucose(
  readings: Reading[],
  index: number,
  endIndex: number,
  radius = 2,
): number | null {
  if (index < 0 || index > endIndex) return null;
  const direct = glucoseAt(readings, index);
  if (direct != null) return direct;
  for (let step = 1; step <= radius; step += 1) {
    if (index - step >= 0 && index - step <= endIndex) {
      const earlier = glucoseAt(readings, index - step);
      if (earlier != null) return earlier;
    }
    if (index + step <= endIndex) {
      const later = glucoseAt(readings, index + step);
      if (later != null) return later;
    }
  }
  return null;
}

function summarizeNight(model: PatientModel, day: number, endIndex: number): NightRow {
  const start = day * STEPS_PER_DAY;
  const close = start + Math.round(NIGHT_END_MIN / STEP_MIN);
  const stop = Math.min(endIndex, close);
  const partial = stop < close;
  let nadir: number | null = null;
  let below70Min = 0;
  let above180Min = 0;
  let gapMin = 0;
  let compressionMin = 0;
  for (let index = start; index <= stop; index += 1) {
    const reading = model.readings[index];
    if (!reading) continue;
    if (reading.cgmGap) gapMin += STEP_MIN;
    if (reading.compressionLow) compressionMin += STEP_MIN;
    const value = glucoseAt(model.readings, index);
    if (value == null) continue;
    nadir = nadir == null ? value : Math.min(nadir, value);
    if (value < 70) below70Min += STEP_MIN;
    if (value > 180) above180Min += STEP_MIN;
  }
  const at4 = nearestGlucose(model.readings, start + Math.round((4 * 60) / STEP_MIN), stop);
  const at8 = partial ? null : nearestGlucose(model.readings, close, stop);
  const night = model.nights[day];
  return {
    dayIndex: day,
    partial,
    sleepHours: night?.durationH ?? 0,
    short: Boolean(night?.short),
    at4,
    at8,
    rise: at4 != null && at8 != null ? at8 - at4 : null,
    nadir,
    below70Min,
    above180Min,
    gapMin,
    compressionMin,
  };
}

/** Midnight–08:00 review. Samples after endIndex are ignored. */
export function nightReview(model: PatientModel, endIndex: number, count = 7): NightReview {
  const capped = Math.max(0, Math.min(model.readings.length - 1, Math.round(endIndex)));
  const minute = (capped * STEP_MIN) % 1440;
  const day = dayOfIndex(capped);
  const lastComplete = minute >= NIGHT_END_MIN ? day : day - 1;
  const rows: NightRow[] = [];
  if (minute < NIGHT_END_MIN) rows.push(summarizeNight(model, day, capped));
  for (let cursor = lastComplete; cursor > lastComplete - count && cursor >= 0; cursor -= 1) {
    rows.push(summarizeNight(model, cursor, capped));
  }
  const bins: NightBin[] = [];
  for (let slot = 0; slot < NIGHT_END_MIN; slot += 30) {
    const values: number[] = [];
    let last: number | null = null;
    rows.forEach((row, rowIndex) => {
      const origin = row.dayIndex * STEPS_PER_DAY;
      const from = origin + Math.round(slot / STEP_MIN);
      const to = Math.min(capped, origin + Math.round((slot + 30) / STEP_MIN) - 1);
      if (from > capped) return;
      let sum = 0;
      let n = 0;
      for (let index = from; index <= to; index += 1) {
        const value = glucoseAt(model.readings, index);
        if (value == null) continue;
        sum += value;
        n += 1;
      }
      if (!n) return;
      const mean = sum / n;
      values.push(mean);
      if (rowIndex === 0) last = mean;
    });
    if (!values.length) continue;
    values.sort((a, b) => a - b);
    bins.push({
      minute: slot,
      p25: quantile(values, 0.25),
      p50: quantile(values, 0.5),
      p75: quantile(values, 0.75),
      last,
    });
  }
  const rises = rows.flatMap((row) => (row.rise == null ? [] : [row.rise])).sort((a, b) => a - b);
  return {
    rows,
    bins,
    medianRise: rises.length ? quantile(rises, 0.5) : null,
  };
}

export function revealOutcome(alert: Alert, available: number): "pending" | "happened" | "missed" {
  const need = alert.kind === "spike" ? 24 : 12;
  if (available < alert.index + need) return "pending";
  return alert.cameTrue ? "happened" : "missed";
}

export function weekStats(model: PatientModel, endIndex: number, days: number) {
  const start = Math.max(0, endIndex - days * STEPS_PER_DAY);
  const values: number[] = [];
  for (let index = start; index <= endIndex; index += 1) {
    const value = glucoseAt(model.readings, index);
    if (value != null) values.push(value);
  }
  if (!values.length) {
    return { mean: 0, sd: 0, tir: 0, tar: 0, tbr: 0, cv: 0, gmi: 0, n: 0, days };
  }
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  const tir = (values.filter((v) => v >= 70 && v <= 180).length / values.length) * 100;
  const tar = (values.filter((v) => v > 180).length / values.length) * 100;
  const tbr = (values.filter((v) => v < 70).length / values.length) * 100;
  return {
    mean,
    sd,
    tir,
    tar,
    tbr,
    cv: mean > 0 ? (sd / mean) * 100 : 0,
    gmi: gmiFromMean(mean),
    n: values.length,
    days,
  };
}

export type AgpBin = {
  minute: number;
  p5: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
};

export function agp(model: PatientModel, endIndex: number, days: number): AgpBin[] {
  const start = Math.max(0, endIndex - days * STEPS_PER_DAY);
  const buckets: number[][] = Array.from({ length: 24 * 2 }, () => []);
  for (let index = start; index <= endIndex; index += 1) {
    const value = glucoseAt(model.readings, index);
    if (value == null) continue;
    const minute = (index * STEP_MIN) % 1440;
    const bin = Math.floor(minute / 30);
    buckets[bin]!.push(value);
  }
  return buckets.map((values, bin) => {
    const sorted = [...values].sort((a, b) => a - b);
    const pick = (p: number) => (sorted.length ? quantile(sorted, p) : 0);
    return {
      minute: bin * 30,
      p5: pick(0.05),
      p25: pick(0.25),
      p50: pick(0.5),
      p75: pick(0.75),
      p95: pick(0.95),
    };
  });
}

export function groupLabel(group: Group): string {
  if (group === "t2d") return "Type 2 diabetes";
  if (group === "prediabetes") return "Prediabetes";
  return "No diabetes";
}

export function rangeLabel(
  glucose: number | null,
): "Below range" | "In range" | "Above range" | "No reading" {
  if (glucose == null) return "No reading";
  if (glucose < 70) return "Below range";
  if (glucose > 180) return "Above range";
  return "In range";
}

/**
 * Open-loop twin level for the plan simulator: the fitted knobs with last
 * night's sleep and HRV, post-walk sensitivity at this minute, and the
 * record's sulfonylurea term. No CGM anchor.
 */
export function twinLevel(
  model: PatientModel,
  absMin: number,
  meals: MacroEvent[],
  walks: WalkEvent[],
  knobs: TwinKnobs = model.params.knobs,
): number {
  const medFromDay = model.patient.sulfonylureaFromDay ?? null;
  const day = Math.floor(absMin / 1440);
  const mask = model.consentOf?.consent.wearable === false ? { sleep: false } : undefined;
  const dayKnobs = medKnobs(
    wearableKnobs(knobs, model.nights, day, absMin, walks, mask),
    absMin,
    medFromDay,
  );
  return levelAt(absMin, meals, walks, dayKnobs) + twinMedOffset(absMin, meals, medFromDay);
}

/** What the app needs from the simulated ward beyond what the generator rebuilds in a few ms. */
export type SimWardSnapshot = {
  version: 1;
  demoIndex: number;
  cues: Cue[];
  trainingMaxCarbs: number;
  seriesLength: number;
  originMs: number;
  lowScale: number;
  spikeScale: number;
  patients: Array<{
    id: string;
    params: TwinParams;
    ehrKnobs: TwinKnobs;
    noRecordKnobs: TwinKnobs;
    bands: Record<30 | 60 | 120, BandOffset>;
    fit: PatientModel["fit"];
    alerts: Alert[];
    driftStart: number | null;
    driftRecovered: number | null;
    /** Base64 of the Float32 / Uint8 arrays. */
    spikeProb: string;
    lowProb: string;
    active: string;
  }>;
};

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export function simWardSnapshot(ward: SimWard): SimWardSnapshot {
  return {
    version: 1,
    demoIndex: ward.demoIndex,
    cues: ward.cues,
    trainingMaxCarbs: ward.trainingMaxCarbs,
    seriesLength: ward.seriesLength,
    originMs: ward.originMs,
    lowScale: ward.lowScale,
    spikeScale: ward.spikeScale,
    patients: ward.patients.map((model) => ({
      id: model.patient.id,
      params: model.params,
      ehrKnobs: model.ehrKnobs,
      noRecordKnobs: model.noRecordKnobs,
      bands: model.bands,
      fit: model.fit,
      alerts: model.alerts,
      driftStart: model.driftStart,
      driftRecovered: model.driftRecovered,
      spikeProb: toBase64(new Uint8Array(model.spikeProb.buffer)),
      lowProb: toBase64(new Uint8Array(model.lowProb.buffer)),
      active: toBase64(model.active),
    })),
  };
}

/**
 * Rebuilds the ward from a snapshot: the generator re-creates schedules, logs
 * and CGM (deterministic, seed 42) and the snapshot supplies everything fitted.
 * `npm test` checks the committed snapshot against a fresh build.
 */
export function simWardFromSnapshot(snapshot: SimWardSnapshot): SimWard {
  const saved = new Map(snapshot.patients.map((row) => [row.id, row]));
  const patients = personas().map((persona): PatientModel => {
    const inputs = simulateInputs(persona, "mismatched");
    const row = saved.get(persona.id);
    if (!row) throw new Error(`ward snapshot has no ${persona.id}`);
    const spike = fromBase64(row.spikeProb);
    const low = fromBase64(row.lowProb);
    return {
      patient: patientRecord(persona, inputs.bmi, inputs.cluster),
      readings: inputs.readings,
      meals: inputs.meals,
      walks: inputs.walks,
      nights: inputs.nights,
      params: row.params,
      popKnobs: POP[persona.group],
      bands: row.bands,
      alerts: row.alerts,
      spikeProb: new Float32Array(spike.buffer, spike.byteOffset, spike.length / 4),
      lowProb: new Float32Array(low.buffer, low.byteOffset, low.length / 4),
      active: fromBase64(row.active),
      fit: row.fit,
      originMs: ORIGIN_MS,
      libreOffset: null,
      ehrKnobs: row.ehrKnobs,
      noRecordKnobs: row.noRecordKnobs,
      alertSetup: {
        readyAt: EVAL_START * STEPS_PER_DAY,
        lowScale: snapshot.lowScale,
        spikeScale: snapshot.spikeScale,
        lowTrend: null,
      },
      driftStart: row.driftStart,
      driftRecovered: row.driftRecovered,
    };
  });
  return {
    patients,
    demoIndex: snapshot.demoIndex,
    cues: snapshot.cues,
    trainingMaxCarbs: snapshot.trainingMaxCarbs,
    seriesLength: snapshot.seriesLength,
    originMs: snapshot.originMs,
    lowScale: snapshot.lowScale,
    spikeScale: snapshot.spikeScale,
  };
}

const consentViews = new WeakMap<PatientModel, Map<string, PatientModel>>();

/**
 * The patient as the twin may see them under stream consent. A withdrawn
 * record drops the record prior (the twin keeps its personal CGM fit, shrunk
 * toward the group prior), the medication list, and widens the band by at
 * least x1.12. A withdrawn wearable drops walks and sleep/HRV. Alerts, risk
 * and drift are rebuilt on what is left, so Twin, What-if, Split, Alerts, the
 * summary and the ward ranking all show the same consented twin. Memoised per
 * model and consent.
 */
export function consentModel(model: PatientModel, consent?: StreamConsent | null): PatientModel {
  const recordOk = consent?.ehr !== false;
  const wearableOk = consent?.wearable !== false;
  if (recordOk && wearableOk) return model;
  const key = `${recordOk ? "r" : "-"}${wearableOk ? "w" : "-"}`;
  let views = consentViews.get(model);
  if (!views) {
    views = new Map();
    consentViews.set(model, views);
  }
  const hit = views.get(key);
  if (hit) return hit;
  const knobs = recordOk ? model.params.knobs : model.noRecordKnobs;
  const medFromDay = recordOk ? (model.patient.sulfonylureaFromDay ?? null) : null;
  const walks = wearableOk ? model.walks : [];
  const bands = consentBands(model, recordOk, wearableOk);
  const setup = model.alertSetup;
  const built = buildAlerts(
    model.patient.id,
    model.readings,
    model.meals,
    walks,
    model.nights,
    knobs,
    bands,
    setup.readyAt,
    setup.lowScale,
    setup.spikeScale,
    medFromDay,
    setup.lowTrend,
    undefined,
    wearableOk ? undefined : { sleep: false, walks: false },
  );
  const view: PatientModel = {
    ...model,
    patient: { ...model.patient, sulfonylureaFromDay: medFromDay },
    walks,
    params: { ...model.params, knobs, prior: recordOk ? model.params.prior : "group" },
    bands,
    alerts: built.alerts,
    spikeProb: built.spikeProb,
    lowProb: built.lowProb,
    active: built.active,
    driftStart: built.driftStart,
    driftRecovered: built.driftRecovered,
    consentOf: { base: model, consent: { ehr: recordOk, wearable: wearableOk } },
  };
  views.set(key, view);
  return view;
}
