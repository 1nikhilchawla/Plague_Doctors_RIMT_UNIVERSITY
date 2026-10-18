import evalFile from "./real_eval.json" with { type: "json" };
import {
  POP,
  STEPS_PER_DAY,
  materializeSeries,
  type CohortEval,
  type Cue,
  type Group,
  type Meal,
  type Night,
  type Patient,
  type PatientModel,
  type Reading,
  type TrendCorrection,
  type Walk,
} from "../cohort.ts";
import { STEP_MIN, type LowTrendRule, type TwinKnobs } from "../physics.ts";
import { seededEhrPrior, type Calibration } from "../ehr.ts";
import { assignCluster } from "../clusters.ts";

export type RealEval = {
  dataset: string;
  version: string;
  doi: string;
  licence: string;
  participants: number;
  skippedSubjects: number[];
  demoSubjects: number[];
  groupCounts: Record<Group, number>;
  horizons: Array<CohortEval["horizons"][number] & { rmseLinear: number }>;
  groups: CohortEval["groups"];
  alerts: CohortEval["alerts"];
  hybrid: Record<
    string,
    {
      kept: boolean;
      rmseTwin: number | null;
      rmseHybrid: number | null;
      heldoutTwin: number | null;
      heldoutHybrid: number | null;
    }
  >;
  ablation?: Array<{ id: string; label: string; rmse60: number; n: number }>;
  ehrBySubject?: Record<string, { ehrKnobs: TwinKnobs; calibration: Calibration }>;
  /** CGM trend rule for lows and its guards, the most frequent leave-one-participant-out choice (null when no rule beat the twin alone). */
  lowRule?: { chosen: LowTrendRule | null; chosenOn: string; guardNote?: string };
  /** Pooled trend correction fit on everyone's uncorrected test rows (the per-person replay uses leave-one-out coefficients). */
  trendCorrection?: Record<"30" | "60" | "120", { slopeGain: number; bias: number }>;
  /** Meal clock and size factors on or off for CGMacros, chosen on validation days 5–6. */
  mealClock?: { chosen: boolean; chosenOn: string; validationRmse60: { on: number | null; off: number | null } };
  note: string;
};

type DemoPatient = {
  patient: {
    id: string;
    subject: number;
    age: number;
    sex: "F" | "M";
    bmi: number;
    weightKg: number;
    heightCm: number;
    hba1c: number;
    fastingGlucose: number | null;
    fastingInsulin: number | null;
    homaIr: number | null;
    triglycerides: number | null;
    hdl: number | null;
    ldl: number | null;
    group: Group;
  };
  origin: string;
  libreOffset: number;
  knobs: TwinKnobs;
  isolatedMeals: number;
  personalTrust?: number;
  bands: Record<"30" | "60" | "120", { q10: number; q90: number }>;
  /** Leave-one-participant-out trend correction for this person, and the band refit after it. */
  trend?: Record<"30" | "60" | "120", { slopeGain: number; bias: number }>;
  trendBands?: Record<"30" | "60" | "120", { q10: number; q90: number }>;
  fit: { rmse60: number; rmse60Pop: number; rmse120: number };
  glucose: Array<number | null>;
  hr: Array<number | null>;
  mets: Array<number | null>;
  gap: boolean[];
  censored: boolean[];
  compression: boolean[];
  worn: boolean[];
  meals: Array<{
    min: number;
    name: string;
    carbs: number;
    fiber: number;
    protein: number;
    fat: number;
    logged: boolean;
  }>;
  walks: Array<{ min: number; durationMin: number; logged: boolean; mets: number }>;
  dayIndex: number[];
  ehrKnobs?: TwinKnobs;
  calibration?: Calibration;
};

export type Ward = {
  patients: PatientModel[];
  seriesLength: number;
  demoIndex: number;
  cues: Cue[];
  trainingMaxCarbs: number;
  source: "simulated" | "cgmacros";
};

function isRealEval(value: unknown): value is RealEval {
  return (
    typeof value === "object" &&
    value !== null &&
    "dataset" in value &&
    value.dataset === "CGMacros" &&
    "horizons" in value &&
    Array.isArray(value.horizons)
  );
}

function checkedRealEval(value: unknown): RealEval {
  if (!isRealEval(value)) throw new Error("real_eval.json is not a CGMacros RealEval report");
  return value;
}

const realEval = checkedRealEval(evalFile);

export function getRealEval(): RealEval {
  return realEval;
}

function originMs(origin: string): number {
  return Date.parse(`${origin.replace(" ", "T")}Z`);
}

function buildOne(row: DemoPatient): PatientModel {
  const id = row.patient.id;
  const readings: Reading[] = row.glucose.map((value, index) => {
    const isGap = row.gap[index] || value == null;
    const compression = Boolean(row.compression[index]);
    return {
      glucose: isGap || compression ? null : value,
      hr: row.hr[index] ?? null,
      mets: row.mets[index] ?? null,
      activityKcal: null,
      worn: Boolean(row.worn[index]),
      cgmGap: isGap,
      cgmNoise: false,
      cgmCensored: Boolean(row.censored[index]),
      compressionLow: compression,
      cgmSource: isGap ? "gap" : "dexcom",
    };
  });
  const meals: Meal[] = row.meals.map((meal, index) => ({
    id: `${id}-m-${index}`,
    min: meal.min,
    carbs: meal.carbs,
    fiber: meal.fiber,
    protein: meal.protein,
    fat: meal.fat,
    name: meal.name,
    logged: true,
    items: [],
  }));
  const walks: Walk[] = row.walks.map((walk) => ({
    min: walk.min,
    durationMin: walk.durationMin,
    logged: true,
    mets: walk.mets,
  }));
  const days = Math.floor(((readings.length - 1) * STEP_MIN) / 1440) + 1;
  const nights: Night[] = Array.from({ length: days }, (_, dayIndex) => ({
    dayIndex,
    durationH: 7,
    efficiency: 0,
    rmssd: 0,
    short: false,
    simulated: false,
  }));
  const label =
    row.patient.group === "t2d"
      ? "Type 2 diabetes by HbA1c"
      : row.patient.group === "prediabetes"
        ? "Prediabetes by HbA1c"
        : "No diabetes by HbA1c";
  const fromFile = realEval.ehrBySubject?.[String(row.patient.subject)];
  const ridge = row.ehrKnobs ?? fromFile?.ehrKnobs;
  const ehrKnobs =
    ridge ??
    seededEhrPrior(
      {
        hba1c: row.patient.hba1c,
        fastingGlucose: row.patient.fastingGlucose,
        fastingInsulin: row.patient.fastingInsulin,
        homaIr: row.patient.homaIr,
        bmi: row.patient.bmi,
        age: row.patient.age,
        sex: row.patient.sex,
      },
      80000 + row.patient.subject,
    );
  const cluster = assignCluster({
    hba1c: row.patient.hba1c,
    bmi: row.patient.bmi,
    age: row.patient.age,
    fastingGlucose: row.patient.fastingGlucose,
    fastingInsulin: row.patient.fastingInsulin,
    triglycerides: row.patient.triglycerides,
    hdl: row.patient.hdl,
  });
  const patient: Patient = {
    id,
    name: id,
    age: row.patient.age,
    sex: row.patient.sex,
    group: row.patient.group,
    heightCm: row.patient.heightCm,
    weightKg: row.patient.weightKg,
    bmi: row.patient.bmi,
    hba1c: row.patient.hba1c,
    hba1cHistory: [{ when: "study lab", percent: row.patient.hba1c }],
    fastingGlucose: row.patient.fastingGlucose,
    fastingInsulin: row.patient.fastingInsulin,
    homaIr: row.patient.homaIr,
    triglycerides: row.patient.triglycerides,
    hdl: row.patient.hdl,
    ldl: row.patient.ldl,
    onMetformin: false,
    alleles: 0,
    diagnoses: [
      label,
      "Watch METs bouts are passed to the twin as known activity",
      ridge
        ? "The record prior is a leave-one-out ridge from the CGMacros labs. The approximate cluster does not shift this ridge."
        : "The record prior is the documented formula until the ridge file is loaded. The approximate cluster does not shift it.",
    ],
    meds: [],
    lagSteps: 0,
    simulated: false,
    cluster: cluster.id,
    clusterNote: cluster.note,
  };
  const trend: TrendCorrection | undefined =
    row.trend && row.trendBands
      ? {
          coef: { 30: row.trend["30"], 60: row.trend["60"], 120: row.trend["120"] },
          bands: { 30: row.trendBands["30"], 60: row.trendBands["60"], 120: row.trendBands["120"] },
        }
      : undefined;
  return materializeSeries({
    patient,
    readings,
    meals,
    walks,
    nights,
    knobs: row.knobs,
    popKnobs: POP[row.patient.group],
    bands: { 30: row.bands["30"], 60: row.bands["60"], 120: row.bands["120"] },
    originMs: originMs(row.origin),
    libreOffset: row.libreOffset,
    ehrKnobs,
    fit: row.fit,
    isolatedMeals: row.isolatedMeals,
    calibration: row.calibration ?? fromFile?.calibration,
    lowTrend: realEval.lowRule?.chosen ?? null,
    trend,
    personalTrust: row.personalTrust,
  });
}

let cached: Ward | null = null;
let loading: Promise<Ward> | null = null;

/**
 * The three held-out CGMacros participants, built from `demo_patients.json`.
 * The caller supplies the file loader, so the series file is fetched only when
 * that source is chosen: the browser passes a plain dynamic import (Vite serves
 * JSON as a JS module), Node passes one with `{ with: { type: "json" } }`.
 */
export function loadRealCohort(load: () => Promise<unknown>): Promise<Ward> {
  if (cached) return Promise.resolve(cached);
  loading ??= load().then((file) => {
    cached = buildRealWard((file as { patients: DemoPatient[] }).patients);
    return cached;
  });
  return loading;
}

function buildRealWard(rows: DemoPatient[]): Ward {
  const patients = rows.map(buildOne);
  const seriesLength = Math.max(...patients.map((model) => model.readings.length));
  let trainingMax = 20;
  for (const model of patients) {
    for (const meal of model.meals) {
      if (meal.min < 4 * 1440) trainingMax = Math.max(trainingMax, meal.carbs);
    }
  }
  const focus = patients.find((model) => model.patient.group === "t2d") ?? patients[0]!;
  const open = focus.readings.findIndex((reading, index) => {
    const day = Math.floor((index * STEP_MIN) / 1440);
    return day >= 6 && reading.glucose != null && reading.glucose > 180;
  });
  const demoIndex = open >= 0 ? open : 6 * STEPS_PER_DAY;
  const cues: Cue[] = patients.map((model) => {
    const index = model.readings.findIndex((reading, cursor) => {
      const day = Math.floor((cursor * STEP_MIN) / 1440);
      return day >= 6 && reading.glucose != null && !reading.cgmGap;
    });
    return {
      id: model.patient.id,
      label: `${model.patient.id} · day 7`,
      patientId: model.patient.id,
      index: index >= 0 ? index : Math.min(demoIndex, model.readings.length - 1),
    };
  });
  return {
    patients,
    seriesLength,
    demoIndex: Math.min(demoIndex, seriesLength - 1),
    cues,
    trainingMaxCarbs: Math.round(trainingMax * 10) / 10,
    source: "cgmacros",
  };
}
