/**
 * Simulated wearable stream shaped like an Apple Health export.
 * Sleep stages and step counts are not measured. They are a documented split
 * of the simulated night, labelled simulated everywhere they appear.
 */

export type SleepStages = {
  awakeMin: number;
  lightMin: number;
  deepMin: number;
  remMin: number;
};

export type AppleHealthRecord = {
  type: "HKCategoryTypeIdentifierSleepAnalysis" | "HKQuantityTypeIdentifierStepCount";
  value: string | number;
  unit: "min" | "count";
  startDate: string;
  endDate: string;
  sourceName: string;
};

export type AppleHealthExport = {
  simulated: true;
  note: string;
  records: AppleHealthRecord[];
};

/** Shares of time in bed. Short nights spend more time awake and less in deep sleep. */
export function sleepStages(durationH: number, short: boolean): SleepStages {
  const total = Math.max(0, Math.round(durationH * 60));
  const awakeMin = Math.round(total * (short ? 0.18 : 0.05));
  const lightMin = Math.round(total * 0.5);
  const deepMin = Math.round(total * (short ? 0.12 : 0.2));
  const used = awakeMin + lightMin + deepMin;
  const remMin = Math.max(0, total - used);
  return { awakeMin, lightMin, deepMin, remMin };
}

/** Modelling assumption: 100 steps per walking minute, plus a seeded background count. */
export const STEPS_PER_WALK_MIN = 100;

export function daySteps(walkMin: number, seed: number, day: number): number {
  const background = 3200 + ((seed * 17 + day * 13) % 9) * 180;
  return background + Math.max(0, walkMin) * STEPS_PER_WALK_MIN;
}

const STAGE_VALUE: Record<keyof SleepStages, string> = {
  awakeMin: "HKCategoryValueSleepAnalysisAwake",
  lightMin: "HKCategoryValueSleepAnalysisAsleepCore",
  deepMin: "HKCategoryValueSleepAnalysisAsleepDeep",
  remMin: "HKCategoryValueSleepAnalysisAsleepREM",
};

export function appleHealthExport(
  nights: { dayIndex: number; stages: SleepStages; steps: number }[],
  originMs: number,
): AppleHealthExport {
  const records: AppleHealthRecord[] = [];
  for (const night of nights) {
    let cursor = originMs + night.dayIndex * 86_400_000 + 23 * 3_600_000;
    (Object.keys(STAGE_VALUE) as (keyof SleepStages)[]).forEach((key) => {
      const minutes = night.stages[key];
      const start = new Date(cursor).toISOString();
      cursor += minutes * 60_000;
      const end = new Date(cursor).toISOString();
      if (minutes <= 0) return;
      records.push({
        type: "HKCategoryTypeIdentifierSleepAnalysis",
        value: STAGE_VALUE[key],
        unit: "min",
        startDate: start,
        endDate: end,
        sourceName: "GlucoTwin simulated",
      });
    });
    const dayStart = new Date(originMs + night.dayIndex * 86_400_000).toISOString();
    const dayEnd = new Date(originMs + (night.dayIndex + 1) * 86_400_000).toISOString();
    records.push({
      type: "HKQuantityTypeIdentifierStepCount",
      value: night.steps,
      unit: "count",
      startDate: dayStart,
      endDate: dayEnd,
      sourceName: "GlucoTwin simulated",
    });
  }
  return {
    simulated: true,
    note: "Apple Health field names and units. Values are simulated, not a device export.",
    records,
  };
}

export function loadAppleHealth(payload: AppleHealthExport): { sleepMin: number; steps: number } {
  let sleepMin = 0;
  let steps = 0;
  for (const record of payload.records) {
    if (record.type === "HKQuantityTypeIdentifierStepCount" && record.unit === "count") {
      steps += Number(record.value) || 0;
    }
    if (
      record.type === "HKCategoryTypeIdentifierSleepAnalysis" &&
      record.unit === "min" &&
      record.value !== "HKCategoryValueSleepAnalysisAwake"
    ) {
      const start = Date.parse(record.startDate);
      const end = Date.parse(record.endDate);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) sleepMin += (end - start) / 60_000;
    }
  }
  return { sleepMin, steps };
}
