/** Pure twin math. No I/O. Glucose is mg/dL unless a function says otherwise. */

export const GLUCOSE_MIN = 40;
export const GLUCOSE_MAX = 400;
export const STEP_MIN = 5;

export type MacroEvent = {
  min: number;
  carbs: number;
  fiber: number;
  protein: number;
  fat: number;
  name: string;
};

export type WalkEvent = {
  min: number;
  durationMin: number;
};

export type TwinKnobs = {
  /** mg/dL peak rise per 10 g carbohydrate, before fiber attenuation. */
  carbSensitivity: number;
  /** mg/dL drop per 30 min of walking. Stored as a positive magnitude. */
  activityEffect: number;
  fastingBaseline: number;
  dawnAmp: number;
  /** Residual half-life-style time constant, minutes. */
  tauMin: number;
  /**
   * Apply the meal clock and size factors (default on). The CGMacros twin
   * switches them off: validation days 5–6 chose the plain triangle there.
   */
  mealClock?: boolean;
  /**
   * "scaled": a negative residual while a meal is active is read as that meal
   * being proportionally smaller, so it scales the meal's remaining curve
   * instead of decaying on its own (default "plain"). Chosen on validation days.
   */
  mealResidual?: "scaled" | "plain";
};

export type BandOffset = { q10: number; q90: number };

export function clipGlucose(value: number): number {
  if (!Number.isFinite(value)) return GLUCOSE_MIN;
  return Math.min(GLUCOSE_MAX, Math.max(GLUCOSE_MIN, value));
}

export function orderQuantiles(a: number, b: number, c: number): [number, number, number] {
  const sorted = [a, b, c].sort((x, y) => x - y);
  return [clipGlucose(sorted[0]!), clipGlucose(sorted[1]!), clipGlucose(sorted[2]!)];
}

export function minuteOfDay(absMin: number): number {
  const day = 1440;
  return ((absMin % day) + day) % day;
}

/** Dawn bump only, 04:00–09:00. Zero outside that window. */
export function dawnRise(absMin: number, dawnAmp: number): number {
  const hour = minuteOfDay(absMin) / 60;
  if (hour < 4 || hour > 9) return 0;
  return dawnAmp * Math.sin(Math.PI * ((hour - 4) / 5));
}

/** Baseline plus a dawn bump (04:00–09:00) and a small diurnal wave. */
export function circadian(absMin: number, dawnAmp: number, baseline: number): number {
  const hour = minuteOfDay(absMin) / 60;
  const diurnal = 3.5 * Math.sin(((hour - 9) / 24) * Math.PI * 2);
  return baseline + dawnRise(absMin, dawnAmp) + diurnal;
}

export function mealShape(delayMin: number, fiberFrac: number): { shape: number; atten: number } {
  if (delayMin < 0 || delayMin >= 180) return { shape: 0, atten: 1 };
  const clamped = Math.min(0.45, Math.max(0, fiberFrac));
  const peakAt = 45 + clamped * 50;
  const shape = delayMin <= peakAt ? delayMin / peakAt : (180 - delayMin) / (180 - peakAt);
  return { shape, atten: 1 - 0.35 * clamped };
}

/**
 * Time-of-day factor for a meal's glucose excursion: postprandial insulin
 * resistance is lower around midday and higher in the evening and at dawn.
 * C(h) = 1 + 0.14·sin(2π(h − 14)/24) + 0.10·sin(π(h − 4)/5) for 4 ≤ h ≤ 9.
 */
export function mealTimeFactor(mealMin: number): number {
  const hour = minuteOfDay(mealMin) / 60;
  const dawn = hour >= 4 && hour <= 9 ? 0.1 * Math.sin(Math.PI * ((hour - 4) / 5)) : 0;
  return 1 + 0.14 * Math.sin((2 * Math.PI * (hour - 14)) / 24) + dawn;
}

/** Large single meals rise more than proportionally: 1 + 0.003 per gram above 40 g. */
export function mealSizeFactor(carbs: number): number {
  return 1 + 0.003 * Math.max(0, carbs - 40);
}

/**
 * Meal excursion. Pass the meal's absolute minute to apply the meal clock:
 * the time-of-day and size factors. Without it the plain triangle is used.
 */
export function mealOffset(
  delayMin: number,
  carbs: number,
  fiber: number,
  sensPer10g: number,
  mealMin?: number,
): number {
  if (carbs <= 0 || delayMin < 0) return 0;
  const { shape, atten } = mealShape(delayMin, fiber / carbs);
  const clock = mealMin == null ? 1 : mealTimeFactor(mealMin) * mealSizeFactor(carbs);
  return ((sensPer10g * carbs) / 10) * atten * shape * clock;
}

/** The meal minute to pass to mealOffset: null when the knobs switch the meal clock off. */
export function mealClockMin(meal: { min: number }, knobs: TwinKnobs): number | undefined {
  return knobs.mealClock === false ? undefined : meal.min;
}

/** Generator-only time-of-day factor: a different shape from the twin's (no dawn term, peak 19:00). */
export function generatorTimeFactor(mealMin: number): number {
  const hour = minuteOfDay(mealMin) / 60;
  return 1 + 0.12 * Math.sin((2 * Math.PI * (hour - 13)) / 24);
}

/**
 * Generator-only absorption. Gamma shape, not the twin's triangle.
 * Fat above 15 g delays the peak and lengthens the tail. Protein above 20 g
 * adds a late rise. Meals above 45 g carbohydrate rise more than proportionally.
 */
export function gammaMealOffset(
  delayMin: number,
  carbs: number,
  fiber: number,
  fat: number,
  protein: number,
  sensPer10g: number,
  mealMin?: number,
): number {
  if (carbs <= 0 || delayMin < 0 || delayMin > 300) return 0;
  const fatDelay = fat > 15 ? Math.min(30, 15 + (fat - 15) * 0.4) : 0;
  const fiberFrac = Math.min(0.45, Math.max(0, fiber / carbs));
  const mode = 40 + fiberFrac * 35 + fatDelay;
  const k = fat > 15 ? 2.3 : 3.5;
  const theta = mode / (k - 1);
  const unit = delayMin / theta;
  const density = unit <= 0 ? 0 : Math.exp((k - 1) * Math.log(unit) - delayMin / theta);
  const modeDensity = Math.exp((k - 1) * Math.log(k - 1) - (k - 1));
  const shape = modeDensity > 0 ? density / modeDensity : 0;
  const nonlinear = carbs <= 45 ? carbs : 45 + (carbs - 45) * 1.35;
  const atten = 1 - 0.2 * fiberFrac;
  const time = mealMin == null ? 1 : generatorTimeFactor(mealMin);
  let value = ((sensPer10g * nonlinear) / 10) * atten * shape * time;
  if (protein > 20 && delayMin >= 90 && delayMin <= 240) {
    value += (protein - 20) * 0.12 * Math.sin(Math.PI * ((delayMin - 90) / 150));
  }
  return value;
}

/** Generator-only walk: drop during the bout, then a 2 h recovery. Not the twin's 75 min triangle. */
export function mismatchedWalkOffset(
  delayMin: number,
  durationMin: number,
  effectPer30: number,
): number {
  if (durationMin <= 0 || delayMin < 0 || effectPer30 === 0) return 0;
  const full = effectPer30 * (durationMin / 30);
  if (delayMin <= durationMin) return -full * (delayMin / durationMin);
  const after = delayMin - durationMin;
  if (after >= 120) return 0;
  return -full * (1 - after / 120);
}

/**
 * Higher insulin sensitivity after a walk ends, fading to 1 over 12–30 h
 * (a 30-min walk still helps the next morning's meals). Muscle glucose uptake
 * stays raised for up to a day or two after aerobic exercise; the size and
 * window are modelling assumptions.
 */
export function postWalkSensitivity(
  absMin: number,
  walks: { min: number; durationMin: number }[],
): number {
  let factor = 1;
  for (const walk of walks) {
    const end = walk.min + walk.durationMin;
    const hours = Math.min(30, 12 + walk.durationMin / 4);
    const span = hours * 60;
    if (absMin < end || absMin >= end + span) continue;
    const fade = 1 - (absMin - end) / span;
    factor *= 1 - 0.28 * fade;
  }
  return factor;
}

export function walkOffset(delayMin: number, durationMin: number, effectPer30: number): number {
  if (durationMin <= 0 || delayMin < 0 || effectPer30 === 0) return 0;
  const full = effectPer30 * (durationMin / 30);
  const end = durationMin;
  const hold = end + 15;
  const recover = end + 75;
  if (delayMin >= recover) return 0;
  if (delayMin <= end) return -full * (delayMin / Math.max(end, 1));
  if (delayMin <= hold) return -full;
  return -full * ((recover - delayMin) / (recover - hold));
}

export function offsetAt(
  absMin: number,
  meals: MacroEvent[],
  walks: WalkEvent[],
  knobs: TwinKnobs,
): number {
  let total = 0;
  for (const meal of meals) {
    const delay = absMin - meal.min;
    if (delay < 0 || delay > 180) continue;
    total += mealOffset(
      delay,
      meal.carbs,
      meal.fiber,
      knobs.carbSensitivity,
      mealClockMin(meal, knobs),
    );
  }
  for (const walk of walks) {
    const delay = absMin - walk.min;
    if (delay < 0 || delay > walk.durationMin + 75) continue;
    total += walkOffset(delay, walk.durationMin, knobs.activityEffect);
  }
  return total;
}

export function levelAt(
  absMin: number,
  meals: MacroEvent[],
  walks: WalkEvent[],
  knobs: TwinKnobs,
): number {
  return (
    circadian(absMin, knobs.dawnAmp, knobs.fastingBaseline) + offsetAt(absMin, meals, walks, knobs)
  );
}

export type CurvePoint = {
  minutesAhead: number;
  p10: number;
  p50: number;
  p90: number;
};

/**
 * Median path is physiology. The band is a split-conformal residual offset
 * that widens over the first 30 minutes so it starts on the current glucose.
 */
export function forecastCurve(input: {
  nowMin: number;
  glucoseNow: number;
  meals: MacroEvent[];
  walks: WalkEvent[];
  knobs: TwinKnobs;
  band: BandOffset;
  horizonMin?: number;
}): CurvePoint[] {
  const horizon = input.horizonMin ?? 120;
  const baseNow = circadian(input.nowMin, input.knobs.dawnAmp, input.knobs.fastingBaseline);
  const offNow = offsetAt(input.nowMin, input.meals, input.walks, input.knobs);
  const residual = input.glucoseNow - baseNow - offNow;
  // A meal that has risen less than modelled is taken to stay proportionally smaller: the
  // part of a negative residual the active meal explains scales that meal's remaining curve
  // instead of decaying on its own, so it cannot drag the forecast below baseline as the
  // meal fades. Meals not yet started (habit or what-if) are not scaled.
  const started = input.meals.filter((meal) => meal.min <= input.nowMin);
  const mealNow = offsetAt(input.nowMin, started, [], input.knobs);
  const scaled = input.knobs.mealResidual === "scaled";
  const mealResidual = scaled && mealNow > 0 && residual < 0 ? Math.max(residual, -mealNow) : 0;
  const mealScale = mealNow > 0 ? (mealNow + mealResidual) / mealNow : 1;
  const points: CurvePoint[] = [];
  const steps = Math.round(horizon / STEP_MIN);
  for (let step = 0; step <= steps; step += 1) {
    const ahead = step * STEP_MIN;
    const abs = input.nowMin + ahead;
    const decay = Math.exp(-ahead / Math.max(30, input.knobs.tauMin));
    const startedLater = mealResidual ? offsetAt(abs, started, [], input.knobs) : 0;
    const pred =
      circadian(abs, input.knobs.dawnAmp, input.knobs.fastingBaseline) +
      offsetAt(abs, input.meals, input.walks, input.knobs) -
      (1 - mealScale) * startedLater +
      (residual - mealResidual) * decay;
    const widen = Math.min(1, ahead / 30);
    const [p10, p50, p90] = orderQuantiles(
      pred + input.band.q10 * widen,
      pred,
      pred + input.band.q90 * widen,
    );
    points.push({ minutesAhead: ahead, p10, p50, p90 });
  }
  return points;
}

export function peakOf(points: CurvePoint[]): number {
  let peak = GLUCOSE_MIN;
  for (const point of points) peak = Math.max(peak, point.p50);
  return peak;
}

export function minutesAbove(points: CurvePoint[], threshold: number): number {
  let count = 0;
  for (const point of points) if (point.p50 > threshold) count += STEP_MIN;
  return count;
}

export function normalCdf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * x);
  const erf = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * erf);
}

export function spikeProbability(current: number, points: CurvePoint[]): number {
  if (current > 180) return 0;
  let peak = points[0]?.p50 ?? current;
  let width = 8;
  for (const point of points) {
    if (point.minutesAhead > 120) break;
    if (point.p50 >= peak) {
      peak = point.p50;
      width = Math.max(6, (point.p90 - point.p10) / 2.563);
    }
  }
  const pHigh = 1 - normalCdf((180 - peak) / width);
  const pRise = 1 - normalCdf((current + 50 - peak) / width);
  return Math.min(0.99, Math.max(0, Math.max(pHigh, pRise)));
}

/**
 * CGM trend rule for lows on real data, mirrored in ml/physics.py and chosen
 * leave-one-participant-out by ml/evaluate_cgmacros.py (`lowRule` in real_eval.json).
 * Guards keep it near the low range: current ≤ `ceiling` mg/dL, or ≤
 * `ceilingFasting` with no meal of 15 g or more in the last 120 min, so a normal
 * post-meal fall is ignored. The last-15-min fall rate is projected `aheadMin`
 * ahead with exponential damping (glucose slows as it nears baseline) and
 * averaged with the twin's 30-min trough. Returns a fixed 0.7 risk, or 0.
 * `postMealCeiling` configures the twin's own post-meal guard (twinLowRisk).
 */
export type LowTrendRule = {
  aheadMin: number;
  fallRate: number;
  dampMin: number;
  blend: number;
  /** Highest current glucose the rule fires at (default 88). */
  ceiling?: number;
  /** Highest current glucose with no meal of 15 g or more in 120 min (default 95). */
  ceilingFasting?: number;
  /** twinLowRisk post-meal ceiling for this ward; null switches that guard off (default 92). */
  postMealCeiling?: number | null;
};

export type LowTrendContext = { twinTrough30: number | null; minutesSinceMeal: number | null };

export function trendLowRisk(
  current: number,
  earlier: number | null,
  rule: LowTrendRule | null,
  context: LowTrendContext = { twinTrough30: null, minutesSinceMeal: null },
): number {
  if (!rule || earlier == null || current < 70) return 0;
  const fasting = context.minutesSinceMeal == null || context.minutesSinceMeal > 120;
  if (!(current <= (rule.ceiling ?? 88) || (fasting && current <= (rule.ceilingFasting ?? 95)))) return 0;
  const rate = (current - earlier) / 15;
  if (rate > rule.fallRate) return 0;
  const damped = current + rate * rule.dampMin * (1 - Math.exp(-rule.aheadMin / rule.dampMin));
  const projected =
    context.twinTrough30 == null
      ? damped
      : (1 - rule.blend) * damped + rule.blend * context.twinTrough30;
  return projected < 70 ? 0.7 : 0;
}

/** Lowest median within the first `minutes` of a curve (null for an empty curve). */
export function troughWithin(points: CurvePoint[], minutes: number): number | null {
  let trough: number | null = null;
  for (const point of points) {
    if (point.minutesAhead > minutes) break;
    trough = trough == null ? point.p50 : Math.min(trough, point.p50);
  }
  return trough;
}

/**
 * Split-conformal 10th–90th band with the finite-sample correction: the lower
 * edge is order statistic ⌊(n+1)·0.1⌋ and the upper ⌈(n+1)·0.9⌉ of the n
 * calibration residuals. Fewer than 20 residuals falls back to ±18 mg/dL.
 */
export function conformalBand(errors: number[]): BandOffset {
  if (errors.length < 20) return { q10: -18, q90: 18 };
  const sorted = [...errors].sort((a, b) => a - b);
  const n = sorted.length;
  const lo = Math.max(1, Math.floor((n + 1) * 0.1));
  const hi = Math.min(n, Math.ceil((n + 1) * 0.9));
  return { q10: sorted[lo - 1]!, q90: sorted[hi - 1]! };
}

/**
 * The twin's low risk with a post-meal guard: within 120 min of a logged meal
 * of 15 g or more, glucose above `postMealCeiling` (default 92 mg/dL; null turns
 * the guard off) is not treated as heading low unless a glucose-lowering drug
 * is active. Mirrored in ml/physics.py.
 */
export function twinLowRisk(
  current: number,
  points: CurvePoint[],
  context: { minutesSinceMeal: number | null; drugActive: boolean; postMealCeiling?: number | null },
): number {
  const ceiling = context.postMealCeiling === undefined ? 92 : context.postMealCeiling;
  const postMeal = context.minutesSinceMeal != null && context.minutesSinceMeal <= 120;
  if (ceiling != null && postMeal && current > ceiling && !context.drugActive) return 0;
  return lowProbability(current, points);
}

export function lowProbability(current: number, points: CurvePoint[]): number {
  if (current < 70) return 0;
  let trough = points[0]?.p50 ?? current;
  let width = 8;
  for (const point of points) {
    if (point.minutesAhead > 60) break;
    if (point.p50 <= trough) {
      trough = point.p50;
      width = Math.max(6, (point.p90 - point.p10) / 2.563);
    }
  }
  return Math.min(0.99, Math.max(0, normalCdf((70 - trough) / width)));
}

export type ProbSample = {
  spike: number;
  low: number;
  gap: boolean;
  day: number;
};

/** Hysteresis, 60-min suppression, daily cap, lows outrank spikes, gaps block. */
export function hygieneFires(
  samples: ProbSample[],
  suppressionSteps = 12,
  dailyCap = 8,
): Array<"spike" | "low" | null> {
  const fires: Array<"spike" | "low" | null> = [];
  let spikeOn = false;
  let lowOn = false;
  let spikeHold = -1e9;
  let lowHold = -1e9;
  let firesToday = 0;
  let day = samples[0]?.day ?? 0;
  samples.forEach((sample, index) => {
    if (sample.day !== day) {
      day = sample.day;
      firesToday = 0;
    }
    if (spikeOn && sample.spike < 0.4) spikeOn = false;
    if (lowOn && sample.low < 0.4) lowOn = false;
    if (sample.gap || firesToday >= dailyCap) {
      fires.push(null);
      return;
    }
    const lowReady = !lowOn && sample.low >= 0.6 && index >= lowHold;
    const spikeReady = !spikeOn && sample.spike >= 0.6 && index >= spikeHold && sample.low < 0.6;
    if (lowReady) {
      lowOn = true;
      lowHold = index + suppressionSteps;
      firesToday += 1;
      fires.push("low");
      return;
    }
    if (spikeReady) {
      spikeOn = true;
      spikeHold = index + suppressionSteps;
      firesToday += 1;
      fires.push("spike");
      return;
    }
    fires.push(null);
  });
  return fires;
}

export function spikeOnset(current: number, futureMax120: number): boolean {
  if (!(current <= 180)) return false;
  return futureMax120 > 180 || futureMax120 - current >= 50;
}

export function lowOnset(current: number, futureMin60: number, blocked: boolean): boolean {
  if (blocked || !(current >= 70)) return false;
  return futureMin60 < 70;
}

export type StreamSample = { glucose: number | null; blocked: boolean };

export type GlucoseEvents = { spikes: number[]; lows: number[] };

/**
 * Event times, not the per-step onset labels.
 * Spike: first reading above 180 after 60 min at or below 180, or the first
 * reading at least 50 mg/dL above the pre-meal glucose when a meal was logged
 * in the previous 120 min. Events within 3 h collapse to the earliest.
 * Low: first reading below 70 after 30 min at or above 70. Gaps and
 * compression samples are not readings.
 */
export function findGlucoseEvents(
  points: StreamSample[],
  meals: { index: number; pre: number | null }[],
  stepMin = STEP_MIN,
): GlucoseEvents {
  const belowNeed = Math.round(60 / stepMin);
  const aboveNeed = Math.round(30 / stepMin);
  const riseSteps = Math.round(120 / stepMin);
  const dedupeSteps = Math.round(180 / stepMin);
  const spikeAt: number[] = [];
  let belowRun = 0;
  let aboveRun = 0;
  const lows: number[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const sample = points[index]!;
    if (sample.blocked || sample.glucose == null) {
      belowRun = 0;
      aboveRun = 0;
      continue;
    }
    if (sample.glucose <= 180) belowRun += 1;
    else {
      if (belowRun >= belowNeed) spikeAt.push(index);
      belowRun = 0;
    }
    if (sample.glucose >= 70) aboveRun += 1;
    else {
      if (aboveRun >= aboveNeed) lows.push(index);
      aboveRun = 0;
    }
  }
  for (const meal of meals) {
    if (meal.pre == null) continue;
    const last = Math.min(points.length - 1, meal.index + riseSteps);
    for (let index = meal.index + 1; index <= last; index += 1) {
      const sample = points[index];
      if (!sample || sample.blocked || sample.glucose == null) continue;
      if (sample.glucose >= meal.pre + 50) {
        spikeAt.push(index);
        break;
      }
    }
  }
  spikeAt.sort((a, b) => a - b);
  const spikes: number[] = [];
  let lastSpike = -1e9;
  for (const index of spikeAt) {
    if (index - lastSpike < dedupeSteps) continue;
    spikes.push(index);
    lastSpike = index;
  }
  return { spikes, lows };
}

export type AlertMark = { index: number; kind: "spike" | "low" };

export type AlertEventScore = {
  spikeEvents: number;
  lowEvents: number;
  spikeAlerts: number;
  lowAlerts: number;
  spikeHits: number;
  lowHits: number;
  spikeFalse: number;
  lowFalse: number;
  leads: number[];
};

/** Hit window is before the event. A false alert has no event in the following window. */
export function scoreAlertEvents(
  spikes: number[],
  lows: number[],
  alerts: AlertMark[],
  stepMin = STEP_MIN,
): AlertEventScore {
  const spikeWindow = Math.round(120 / stepMin);
  const lowWindow = Math.round(60 / stepMin);
  const leads: number[] = [];
  let spikeHits = 0;
  let lowHits = 0;
  for (const event of spikes) {
    const prior = alerts.filter(
      (alert) =>
        alert.kind === "spike" && alert.index >= event - spikeWindow && alert.index < event,
    );
    if (!prior.length) continue;
    spikeHits += 1;
    const first = Math.min(...prior.map((alert) => alert.index));
    leads.push((event - first) * stepMin);
  }
  for (const event of lows) {
    const prior = alerts.filter(
      (alert) => alert.kind === "low" && alert.index >= event - lowWindow && alert.index < event,
    );
    if (!prior.length) continue;
    lowHits += 1;
    const first = Math.min(...prior.map((alert) => alert.index));
    leads.push((event - first) * stepMin);
  }
  const spikeAlerts = alerts.filter((alert) => alert.kind === "spike");
  const lowAlerts = alerts.filter((alert) => alert.kind === "low");
  const isFalse = (alert: AlertMark, events: number[], follow: number) =>
    !events.some((event) => event > alert.index && event <= alert.index + follow);
  return {
    spikeEvents: spikes.length,
    lowEvents: lows.length,
    spikeAlerts: spikeAlerts.length,
    lowAlerts: lowAlerts.length,
    spikeHits,
    lowHits,
    spikeFalse: spikeAlerts.filter((alert) => isFalse(alert, spikes, spikeWindow)).length,
    lowFalse: lowAlerts.filter((alert) => isFalse(alert, lows, lowWindow)).length,
    leads,
  };
}

export function carbsOnBoard(nowMin: number, meals: { min: number; carbs: number }[]): number {
  let total = 0;
  for (const meal of meals) {
    if (meal.min > nowMin) continue;
    const remaining = 1 - (nowMin - meal.min) / 180;
    if (remaining > 0) total += meal.carbs * remaining;
  }
  return total;
}

export type FeatureRow = {
  current: number | null;
  lag30: number | null;
  slope30: number | null;
  cob: number;
  lastCarbs: number;
  minutesSinceMeal: number | null;
};

export function featuresAt(input: {
  nowMin: number;
  glucose: { min: number; value: number | null }[];
  meals: { min: number; carbs: number }[];
}): FeatureRow {
  const past = input.glucose.filter((point) => point.min <= input.nowMin && point.value != null);
  const current = past.length ? past[past.length - 1]!.value : null;
  const lagPoint = [...past].reverse().find((point) => input.nowMin - point.min >= 30);
  const lag30 = lagPoint?.value ?? null;
  const slope30 = current != null && lag30 != null ? (current - lag30) / 30 : null;
  const meals = input.meals.filter((meal) => meal.min <= input.nowMin);
  const last = meals.length ? meals[meals.length - 1] : undefined;
  return {
    current,
    lag30,
    slope30,
    cob: carbsOnBoard(input.nowMin, meals),
    lastCarbs: last?.carbs ?? 0,
    minutesSinceMeal: last ? input.nowMin - last.min : null,
  };
}

/** Clarke Error Grid zone. Reference is the laboratory/true glucose. */
export function clarkeZone(reference: number, prediction: number): "A" | "B" | "C" | "D" | "E" {
  const y = reference;
  const yp = prediction;
  if ((yp <= 70 && y <= 70) || (yp <= 1.2 * y && yp >= 0.8 * y)) return "A";
  if ((y >= 180 && yp <= 70) || (y <= 70 && yp >= 180)) return "E";
  if ((y >= 70 && y <= 290 && yp >= y + 110) || (y >= 130 && y <= 180 && yp <= (7 / 5) * y - 182)) {
    return "C";
  }
  if (
    (y >= 240 && yp >= 70 && yp <= 180) ||
    (y <= 175 / 3 && yp <= 180 && yp >= 70) ||
    (y >= 175 / 3 && y <= 70 && yp >= (6 / 5) * y)
  ) {
    return "D";
  }
  return "B";
}

export function mgdlToMmol(mgdl: number): number {
  return mgdl / 18;
}

export function mmolToMgdl(mmol: number): number {
  return mmol * 18;
}

/** NGSP % → IFCC mmol/mol. */
export function hba1cPercentToMmol(percent: number): number {
  return (percent - 2.15) * 10.929;
}

export function homaIr(fastingGlucoseMgdl: number, insulinMicroU: number): number | null {
  if (!(insulinMicroU > 0) || !(fastingGlucoseMgdl > 0)) return null;
  return (fastingGlucoseMgdl * insulinMicroU) / 405;
}

export function gmiFromMean(meanMgdl: number): number {
  return 3.31 + 0.02392 * meanMgdl;
}

export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! * (hi - idx) + sorted[hi]! * (idx - lo);
}

export function activityWhenWorn(worn: boolean, kcal: number): number | null {
  return worn ? kcal : null;
}

const NUMBER_RE = /\d+(?:\.\d+)?/g;

export function extractNumbers(text: string): number[] {
  return (text.match(NUMBER_RE) ?? []).map(Number);
}

export function numbersAreAllowed(text: string, allowed: number[]): boolean {
  return extractNumbers(text).every((found) => allowed.some((ok) => Math.abs(ok - found) < 0.051));
}

export type NoteFacts = {
  mean: number;
  gmi: number;
  tir: number;
  tar: number;
  tbr: number;
  cv: number;
  tirDelta: number;
  fasting: number;
  carbPer10: number;
  days: number;
};

export function clinicalNote(facts: NoteFacts): { text: string; source: "template" | "fallback" } {
  const mean = Math.round(facts.mean);
  const gmi = Math.round(facts.gmi * 10) / 10;
  const tir = Math.round(facts.tir);
  const tar = Math.round(facts.tar);
  const tbr = Math.round(facts.tbr);
  const cv = Math.round(facts.cv);
  const tirDelta = Math.round(facts.tirDelta);
  const fasting = Math.round(facts.fasting);
  const carb = Math.round(facts.carbPer10 * 10) / 10;
  const days = facts.days;
  const allowed = [
    mean,
    gmi,
    tir,
    tar,
    tbr,
    cv,
    tirDelta,
    Math.abs(tirDelta),
    fasting,
    carb,
    days,
    70,
    180,
    10,
  ];
  const direction =
    tirDelta >= 0
      ? `Time in range is ${tirDelta} percentage points higher than the previous window.`
      : `Time in range is ${Math.abs(tirDelta)} percentage points lower than the previous window.`;
  const text = [
    `Over ${days} days, mean glucose was ${mean} mg/dL (GMI ${gmi}%).`,
    `Time in range 70–180 was ${tir}%, above range ${tar}%, below range ${tbr}%.`,
    `Coefficient of variation was ${cv}%.`,
    direction,
    `Fasting baseline is ${fasting} mg/dL. Carb sensitivity is ${carb} mg/dL per 10 g.`,
    "This note only restates computed figures. It is not a diagnosis and not a medication change.",
  ].join(" ");
  if (!numbersAreAllowed(text, allowed)) {
    const fallback = `A weekly summary could not be checked against the source figures. Mean glucose ${mean} mg/dL, time in range ${tir}%. Not a diagnosis.`;
    return { text: fallback, source: "fallback" };
  }
  return { text, source: "template" };
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sleepFactor(hours: number): number {
  if (hours >= 7) return 1;
  if (hours >= 6) return 1.06;
  return 1.12;
}

/** Last night as the wearable reports it. Zero efficiency or RMSSD means "not measured". */
export type WearableNight = { sleepH: number; efficiency: number; rmssd: number };

function nightLoad(
  night: WearableNight,
  rmssdBaseline: number,
): { debt: number; poorEff: number; hrvDrop: number } {
  const debt = Math.min(4, Math.max(0, 7 - night.sleepH));
  const poorEff = night.efficiency > 0 ? Math.min(0.3, Math.max(0, 0.9 - night.efficiency)) : 0;
  const hrvDrop =
    night.rmssd > 0 && rmssdBaseline > 0
      ? Math.min(0.5, Math.max(0, (rmssdBaseline - night.rmssd) / rmssdBaseline))
      : 0;
  return { debt, poorEff, hrvDrop };
}

/** Share of the night before last that is still felt today: sleep debt accumulates. */
export const SLEEP_CARRY = 0.5;

function carriedLoad(
  night: WearableNight,
  rmssdBaseline: number,
  previous?: WearableNight,
): { debt: number; poorEff: number; hrvDrop: number } {
  const now = nightLoad(night, rmssdBaseline);
  if (!previous) return now;
  const before = nightLoad(previous, rmssdBaseline);
  return {
    debt: now.debt + SLEEP_CARRY * before.debt,
    poorEff: now.poorEff + SLEEP_CARRY * before.poorEff,
    hrvDrop: now.hrvDrop + SLEEP_CARRY * before.hrvDrop,
  };
}

/**
 * Carb-sensitivity multiplier (an insulin-resistance proxy) from last night's
 * sleep debt, sleep efficiency and HRV drop against the person's own baseline,
 * plus half of the night before. It holds for the whole day. Direction and
 * size follow short-sleep and autonomic-stress studies (one night of ~4 h
 * sleep lowers insulin sensitivity by a fifth to a quarter); the exact sizes
 * are modelling assumptions. 1 when both nights are normal or not measured.
 */
export function wearableSensitivity(
  night: WearableNight,
  rmssdBaseline: number,
  previous?: WearableNight,
): number {
  const { debt, poorEff, hrvDrop } = carriedLoad(night, rmssdBaseline, previous);
  return 1 + 0.08 * debt + 0.4 * poorEff + 0.4 * hrvDrop;
}

/** Dawn-rise multiplier: short, stressed nights raise the early-morning climb. */
export function wearableDawn(
  night: WearableNight,
  rmssdBaseline: number,
  previous?: WearableNight,
): number {
  const { debt, hrvDrop } = carriedLoad(night, rmssdBaseline, previous);
  return 1 + 0.12 * debt + 0.5 * hrvDrop;
}
