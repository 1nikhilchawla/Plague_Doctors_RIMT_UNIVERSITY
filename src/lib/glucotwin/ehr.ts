/** Cold-start record prior and small scoring helpers. No hidden generator parameters. */

import { mulberry32, type TwinKnobs } from "./physics.ts";

export type RecordFeatures = {
  hba1c: number;
  fastingGlucose: number | null;
  fastingInsulin: number | null;
  homaIr: number | null;
  bmi: number;
  age: number;
  sex: "F" | "M";
  /** Simulated TCF7L2 risk-allele count. Omitted means unknown, treated as 0. */
  alleles?: 0 | 1 | 2;
};

export type Calibration = {
  carbMean: number | null;
  carbN: number;
  actMean: number | null;
  actN: number;
  fastingMedian: number | null;
};

const GROUP_DAWN = { t2d: 22, prediabetes: 8, healthy: 3 };
const GROUP_TAU = { t2d: 150, prediabetes: 100, healthy: 70 };
const GROUP_CARB = [12, 7.2, 4.4];
const GROUP_ACT = [14, 18, 20];
const GROUP_FAST = [140, 106, 92];

/** Unweighted mean of the three group priors. No diagnosis and no labs. */
export function globalKnobs(): TwinKnobs {
  const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    carbSensitivity: mean(GROUP_CARB),
    activityEffect: mean(GROUP_ACT),
    fastingBaseline: mean(GROUP_FAST),
    dawnAmp: mean([22, 8, 3]),
    tauMin: mean([150, 100, 70]),
  };
}

function clip(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Documented cold-start map from the lab record. Noise is one standard normal
 * per knob, seeded by the caller. This is not the generator's hidden knobs.
 * Dawn and tau stay on the HbA1c group because the record has no overnight shape.
 * Each TCF7L2 allele adds 0.35 to carb sensitivity. That term is a modelling assumption, not a published effect size.
 * Age is not in this formula. It acts through the approximate cluster label
 * (MARD at 60 or older with HbA1c under 8.5%, clusters.ts), whose shift is
 * added to this prior. The CGMacros ridge prior uses age directly.
 */
export function ehrPrior(record: RecordFeatures, rand: () => number = Math.random): TwinKnobs {
  const hba = record.hba1c;
  const fasting = record.fastingGlucose ?? 90 + (hba - 5) * 20;
  const homa = record.homaIr ?? 1;
  const sex = record.sex === "F" ? 1 : 0;
  const alleles = record.alleles ?? 0;
  const normal = () => {
    const u = Math.max(1e-9, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const group = hba >= 6.5 ? "t2d" : hba >= 5.7 ? "prediabetes" : "healthy";
  return {
    carbSensitivity: clip(
      3.1 +
        1.35 * (hba - 5) +
        0.08 * Math.max(0, homa - 1) +
        0.4 * sex +
        0.35 * alleles +
        normal() * 0.6,
      0.5,
      40,
    ),
    fastingBaseline: clip(fasting * 0.72 + (70 + 11 * (hba - 5)) * 0.28 + normal() * 3, 70, 220),
    activityEffect: clip(24 - 1.1 * (hba - 5) - 0.15 * (record.bmi - 22) + normal() * 1.5, 0, 80),
    dawnAmp: GROUP_DAWN[group],
    tauMin: GROUP_TAU[group],
  };
}

export function seededEhrPrior(record: RecordFeatures, seed: number): TwinKnobs {
  return ehrPrior(record, mulberry32(seed));
}

function shrinkN(mean: number, n: number, prior: number, k: number): number {
  return (n * mean + k * prior) / (n + k);
}

/** Same shrinkage as the live twin, but the prior can be the record instead of the group. */
export function knobsToward(calibration: Calibration, prior: TwinKnobs): TwinKnobs {
  const carb =
    calibration.carbN > 0 && calibration.carbMean != null
      ? shrinkN(calibration.carbMean, calibration.carbN, prior.carbSensitivity, 3)
      : prior.carbSensitivity;
  const act =
    calibration.actN > 0 && calibration.actMean != null
      ? shrinkN(calibration.actMean, calibration.actN, prior.activityEffect, 1)
      : prior.activityEffect;
  return {
    carbSensitivity: clip(carb, 0.5, 40),
    activityEffect: clip(act, 0, 80),
    fastingBaseline: calibration.fastingMedian ?? prior.fastingBaseline,
    dawnAmp: prior.dawnAmp,
    tauMin: prior.tauMin,
  };
}

/** Wilson score interval for a proportion. z = 1.96 is the 95% interval. */
export function wilson(hits: number, n: number, z = 1.96): [number, number] | null {
  if (!(n > 0) || hits < 0 || hits > n) return null;
  const p = hits / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / den;
  const margin = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / den;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

/**
 * A step is "outside" when that minute's glucose missed the band forecast 30 min earlier.
 * Drift starts once more than 35% of a rolling 12 h is outside, and that stays true for 6 h.
 * It recovers after 6 h back under the threshold.
 */
export function driftWindows(
  outside: boolean[],
  windowSteps = 144,
  needShare = 0.35,
  sustainSteps = 72,
): { start: number | null; recovered: number | null } {
  let hot = 0;
  let cool = 0;
  let start: number | null = null;
  let recovered: number | null = null;
  for (let index = 0; index < outside.length; index += 1) {
    const from = Math.max(0, index - windowSteps + 1);
    let out = 0;
    let n = 0;
    for (let cursor = from; cursor <= index; cursor += 1) {
      n += 1;
      if (outside[cursor]) out += 1;
    }
    const hotNow = n >= windowSteps && out / n > needShare;
    if (start == null) {
      hot = hotNow ? hot + 1 : 0;
      if (hot >= sustainSteps) start = index - sustainSteps + 1;
      continue;
    }
    if (recovered != null) continue;
    cool = hotNow ? 0 : cool + 1;
    if (cool >= sustainSteps) recovered = index - sustainSteps + 1;
  }
  return { start, recovered };
}

const NESTED_CLOCKS: Record<2 | 4 | 6 | 8, number[]> = {
  2: [8 * 60, 20 * 60],
  4: [8 * 60, 12 * 60, 16 * 60, 20 * 60],
  6: [8 * 60, 10 * 60, 12 * 60, 14 * 60, 16 * 60, 20 * 60],
  // The two extra 8/day pricks go at 03:00 (overnight trough) and 07:00, not late evening:
  // a 22:00 prick sits on the dinner tail and the line from it to breakfast overshoots the night.
  8: [3 * 60, 7 * 60, 8 * 60, 10 * 60, 12 * 60, 14 * 60, 16 * 60, 20 * 60],
};

export function prickClocks(perDay: 2 | 4 | 6 | 8): number[] {
  return NESTED_CLOCKS[perDay];
}

/** Linear fill between nested finger-pricks. Ends hold the nearest prick. */
export function interpolatePricks(
  values: Array<number | null>,
  stepMin: number,
  clocks: number[],
): Array<number | null> {
  const known: { index: number; value: number }[] = [];
  const clockSet = new Set(clocks);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value == null) continue;
    if (!clockSet.has((index * stepMin) % 1440)) continue;
    known.push({ index, value });
  }
  const filled: Array<number | null> = values.map(() => null);
  if (!known.length) return filled;
  const first = known[0]!;
  const last = known[known.length - 1]!;
  for (let index = 0; index < first.index; index += 1) filled[index] = first.value;
  for (let index = last.index; index < filled.length; index += 1) filled[index] = last.value;
  for (let pair = 0; pair < known.length - 1; pair += 1) {
    const left = known[pair]!;
    const right = known[pair + 1]!;
    const span = right.index - left.index;
    for (let index = left.index; index <= right.index; index += 1) {
      const t = span === 0 ? 0 : (index - left.index) / span;
      filled[index] = left.value + (right.value - left.value) * t;
    }
  }
  return filled;
}

export function maskedRmse(truth: Array<number | null>, filled: Array<number | null>): number {
  let sse = 0;
  let n = 0;
  for (let index = 0; index < truth.length; index += 1) {
    const actual = truth[index];
    const pred = filled[index];
    if (actual == null || pred == null) continue;
    sse += (pred - actual) ** 2;
    n += 1;
  }
  return n ? Math.sqrt(sse / n) : 0;
}
