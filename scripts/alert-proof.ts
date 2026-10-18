/**
 * Warning-time proof on the simulated stress test (mismatched generator).
 *
 * Every method is scored on the same glucose events, with the same alert
 * hygiene (hygieneFires: hysteresis, 60-min suppression, daily cap, gaps block)
 * and the same scorer (scoreAlertEvents) the README uses:
 *   - GlucoTwin alerts, rebuilt from the stored per-step risk at the live 0.6 threshold
 *   - CGM-only alarms: a rise-rate alarm and straight-line trend projections
 *   - a "big meal" carb rule that warns at every logged meal above a carb cutoff
 * It also reports the twin's warning-time distribution, a threshold sweep and
 * how well the displayed risk numbers are calibrated.
 *
 * Writes reports/alert_proof.json and docs/ALERT_PROOF.md.
 * Run: node --experimental-strip-types scripts/alert-proof.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAYS, STEPS_PER_DAY, getCohort, type PatientModel } from "../src/lib/glucotwin/cohort.ts";
import { wilson } from "../src/lib/glucotwin/ehr.ts";
import {
  STEP_MIN,
  findGlucoseEvents,
  hygieneFires,
  lowOnset,
  mulberry32,
  scoreAlertEvents,
  spikeOnset,
  type AlertMark,
} from "../src/lib/glucotwin/physics.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cohort = getCohort();
const models = cohort.patients;
const evalDays = cohort.eval.alerts.evalDays;
const from = (DAYS - evalDays) * STEPS_PER_DAY;
const patientDays = models.length * evalDays;

type Signal = { spike: boolean; low: boolean };
type Method = {
  id: string;
  label: string;
  uses: string;
  signal: (model: PatientModel) => Signal[] | null;
  risk?: true;
};

const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
};
const band = (hits: number, n: number) => {
  const w = wilson(hits, n);
  return w ? [round(w[0]), round(w[1])] : null;
};

// A reading the twin cannot use (same rule as the live sampler).
function blockedForTwin(model: PatientModel, index: number): boolean {
  const r = model.readings[index];
  return !r || r.glucose == null || r.cgmGap || r.compressionLow || r.cgmCensored;
}

// A reading the event finder counts (same rule as the README scorer).
function eventPoints(model: PatientModel) {
  return model.readings.map((r) => ({
    glucose: r?.glucose ?? null,
    blocked: !r || r.glucose == null || r.cgmGap || r.compressionLow,
  }));
}

function events(model: PatientModel) {
  const glucoseAt = (index: number) => {
    const r = model.readings[index];
    return !r || r.cgmGap || r.compressionLow ? null : r.glucose;
  };
  const meals = model.meals
    .filter((meal) => meal.logged)
    .map((meal) => {
      const index = Math.round(meal.min / STEP_MIN);
      return { index, pre: glucoseAt(index) };
    });
  const found = findGlucoseEvents(eventPoints(model), meals, STEP_MIN);
  return {
    spikes: found.spikes.filter((i) => i >= from),
    lows: found.lows.filter((i) => i >= from),
  };
}

/** Same hygiene for every method: probabilities in, alert marks out. */
function alertsFrom(
  model: PatientModel,
  spike: ArrayLike<number>,
  low: ArrayLike<number>,
): AlertMark[] {
  const fires = hygieneFires(
    Array.from({ length: model.readings.length }, (_, index) => ({
      spike: spike[index] ?? 0,
      low: low[index] ?? 0,
      gap: blockedForTwin(model, index),
      day: Math.floor((index * STEP_MIN) / 1440),
    })),
  );
  const marks: AlertMark[] = [];
  fires.forEach((kind, index) => {
    if (kind && index >= from) marks.push({ index, kind });
  });
  return marks;
}

function indicatorAlerts(model: PatientModel, signal: Signal[]): AlertMark[] {
  return alertsFrom(
    model,
    signal.map((s) => (s.spike ? 1 : 0)),
    signal.map((s) => (s.low ? 1 : 0)),
  );
}

/** Twin alerts at threshold θ: scale risk so hygieneFires' 0.6 / 0.4 hysteresis becomes θ / (2θ/3). */
function twinAlerts(model: PatientModel, theta: number, thetaLow = theta): AlertMark[] {
  const scale = (arr: Float32Array, t: number) => Array.from(arr, (p) => p * (0.6 / t));
  return alertsFrom(model, scale(model.spikeProb, theta), scale(model.lowProb, thetaLow));
}

/** The live thresholds were chosen on validation days inside the cohort build; recover them from the stored alerts. */
function liveThresholds(): { spike: number; low: number } {
  const stored = cohort.eval.alerts;
  for (const spike of [0.6, 0.7, 0.8, 0.9]) {
    for (const low of [0.6, 0.5, 0.4, 0.3, 0.2]) {
      let alerts = 0;
      let lows = 0;
      for (const model of models) {
        const marks = twinAlerts(model, spike, low);
        alerts += marks.filter((m) => m.kind === "spike").length;
        lows += marks.filter((m) => m.kind === "low").length;
      }
      if (alerts === stored.spikeAlerts && lows === stored.lowAlerts) return { spike, low };
    }
  }
  return { spike: 0.6, low: 0.6 };
}
const LIVE = liveThresholds();

// ------------------------------------------------------------------ CGM-only and meal baselines
function glucose(model: PatientModel, index: number): number | null {
  return index < 0 || blockedForTwin(model, index) ? null : model.readings[index]!.glucose;
}

/** Least-squares slope (mg/dL per min) over the last 30 min; null with fewer than 5 readings. */
function slope30(model: PatientModel, index: number): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (let k = index - 6; k <= index; k += 1) {
    const g = glucose(model, k);
    if (g != null) {
      xs.push(k * STEP_MIN);
      ys.push(g);
    }
  }
  if (xs.length < 5) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  xs.forEach((x, i) => {
    num += (x - mx) * (ys[i]! - my);
    den += (x - mx) ** 2;
  });
  return den > 0 ? num / den : null;
}

function riseRate(model: PatientModel): Signal[] {
  return model.readings.map((_, i) => {
    const g = glucose(model, i);
    const g15 = glucose(model, i - 3);
    if (g == null || g15 == null) return { spike: false, low: false };
    const rate = (g - g15) / 15;
    return { spike: g <= 180 && rate >= 2, low: g >= 70 && g <= 110 && rate <= -2 };
  });
}

function trend(horizonMin: number) {
  return (model: PatientModel): Signal[] =>
    model.readings.map((_, i) => {
      const g = glucose(model, i);
      const s = slope30(model, i);
      if (g == null || s == null) return { spike: false, low: false };
      const ahead = g + s * horizonMin;
      return {
        spike: g <= 180 && (ahead > 180 || ahead - g >= 50),
        low: g >= 70 && g + s * 30 < 70,
      };
    });
}

function carbRule(minCarbs: number) {
  return (model: PatientModel): Signal[] => {
    const out: Signal[] = model.readings.map(() => ({ spike: false, low: false }));
    for (const meal of model.meals) {
      if (!meal.logged || meal.carbs < minCarbs) continue;
      const index = Math.round(meal.min / STEP_MIN);
      if (out[index]) out[index] = { spike: true, low: false };
    }
    return out;
  };
}

const METHODS: Method[] = [
  {
    id: "twin",
    label: `GlucoTwin (live, risk ≥ ${LIVE.spike})`,
    uses: "CGM + logged meals and walks + sleep + fitted knobs from the record",
    signal: () => null,
    risk: true,
  },
  {
    id: "rise",
    label: "Rise-rate alarm",
    uses: "CGM only: rising ≥ 2 mg/dL/min over 15 min (low: falling ≥ 2 mg/dL/min under 110)",
    signal: riseRate,
  },
  {
    id: "trend60",
    label: "Trend projection, 60 min",
    uses: "CGM only: 30-min straight-line trend projected 60 min ahead crosses 180 or rises 50",
    signal: trend(60),
  },
  {
    id: "trend120",
    label: "Trend projection, 120 min",
    uses: "CGM only: same trend projected 120 min ahead",
    signal: trend(120),
  },
  {
    id: "carb40",
    label: "Big-meal rule, ≥ 40 g carbs",
    uses: "Meal log only: warn at every logged meal with at least 40 g carbohydrate",
    signal: carbRule(40),
  },
  {
    id: "carb60",
    label: "Big-meal rule, ≥ 60 g carbs",
    uses: "Meal log only: warn at every logged meal with at least 60 g carbohydrate",
    signal: carbRule(60),
  },
];

type Score = ReturnType<typeof summarise>;

function summarise(id: string, label: string, uses: string, perModel: AlertMark[][]) {
  let spikeEvents = 0,
    lowEvents = 0,
    spikeAlerts = 0,
    lowAlerts = 0;
  let spikeHits = 0,
    lowHits = 0,
    spikeFalse = 0,
    lowFalse = 0;
  const leads: number[] = [];
  models.forEach((model, m) => {
    const { spikes, lows } = events(model);
    const alerts = perModel[m]!;
    const spikeScore = scoreAlertEvents(
      spikes,
      [],
      alerts.filter((a) => a.kind === "spike"),
      STEP_MIN,
    );
    const lowScore = scoreAlertEvents(
      [],
      lows,
      alerts.filter((a) => a.kind === "low"),
      STEP_MIN,
    );
    spikeEvents += spikeScore.spikeEvents;
    spikeAlerts += spikeScore.spikeAlerts;
    spikeHits += spikeScore.spikeHits;
    spikeFalse += spikeScore.spikeFalse;
    leads.push(...spikeScore.leads);
    lowEvents += lowScore.lowEvents;
    lowAlerts += lowScore.lowAlerts;
    lowHits += lowScore.lowHits;
    lowFalse += lowScore.lowFalse;
  });
  leads.sort((a, b) => a - b);
  const spikeTrue = spikeAlerts - spikeFalse;
  const lowTrue = lowAlerts - lowFalse;
  const recall = spikeEvents ? spikeHits / spikeEvents : 0;
  const precision = spikeAlerts ? spikeTrue / spikeAlerts : 0;
  const warned = (min: number) => leads.filter((lead) => lead >= min).length;
  return {
    id,
    label,
    uses,
    spike: {
      events: spikeEvents,
      alerts: spikeAlerts,
      hits: spikeHits,
      recall: round(recall),
      recallWilson: band(spikeHits, spikeEvents),
      precision: spikeAlerts ? round(precision) : null,
      precisionWilson: band(spikeTrue, spikeAlerts),
      f1: recall + precision > 0 ? round((2 * recall * precision) / (recall + precision)) : 0,
      falsePerPatientDay: round(spikeFalse / patientDays, 2),
      // Whole minutes, as the README rounds the same spike leads (cohort.ts buildEval).
      medianLeadMin: leads.length ? Math.round(quantile(leads, 0.5)!) : null,
      leadIqrMin: leads.length
        ? [Math.round(quantile(leads, 0.25)!), Math.round(quantile(leads, 0.75)!)]
        : null,
      warnedAtLeast30: { count: warned(30), share: round(warned(30) / spikeEvents) },
      warnedAtLeast60: { count: warned(60), share: round(warned(60) / spikeEvents) },
      warnedAtLeast90: { count: warned(90), share: round(warned(90) / spikeEvents) },
    },
    low: {
      events: lowEvents,
      alerts: lowAlerts,
      hits: lowHits,
      recall: lowEvents ? round(lowHits / lowEvents) : null,
      precision: lowAlerts ? round(lowTrue / lowAlerts) : null,
      falsePerPatientDay: round(lowFalse / patientDays, 2),
    },
    leads,
  };
}

// ------------------------------------------------------------------ run methods
const scores: Score[] = METHODS.map((method) => {
  const perModel = models.map((model) =>
    method.risk ? twinAlerts(model, LIVE.spike, LIVE.low) : indicatorAlerts(model, method.signal(model)!),
  );
  return summarise(method.id, method.label, method.uses, perModel);
});
const twin = scores[0]!;

// Sanity check: the rebuilt twin alerts must match the stored evaluation.
const stored = cohort.eval.alerts;
const reproduced =
  twin.spike.alerts === stored.spikeAlerts &&
  twin.spike.hits === stored.spikeHits &&
  twin.spike.events === stored.spikeEvents;

// Warning-time distribution for twin hits (lead is a multiple of 5 min, at most 120 by the scorer window).
const bins = [
  { label: "5–15 min", lo: 5, hi: 15 },
  { label: "20–30 min", lo: 20, hi: 30 },
  { label: "35–55 min", lo: 35, hi: 55 },
  { label: "60–90 min", lo: 60, hi: 90 },
  { label: "95–120 min", lo: 95, hi: 120 },
].map((b) => ({ ...b, count: twin.leads.filter((l) => l >= b.lo && l <= b.hi).length }));

// Threshold sweep for the twin.
const sweep = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9].map((theta) => {
  const s = summarise(
    `twin@${theta}`,
    `θ=${theta}`,
    "",
    models.map((model) => twinAlerts(model, theta, LIVE.low)),
  );
  return {
    threshold: theta,
    recall: s.spike.recall,
    precision: s.spike.precision,
    f1: s.spike.f1,
    falsePerPatientDay: s.spike.falsePerPatientDay,
    medianLeadMin: s.spike.medianLeadMin,
    warnedAtLeast60Share: s.spike.warnedAtLeast60.share,
  };
});

// ------------------------------------------------------------------ discrimination of the displayed risk
type RiskRow = { p: number; y: number; patient: number };

/** Area under the ROC curve (Mann–Whitney, ties at half weight). */
function aurocOf(rows: RiskRow[]): number | null {
  const sorted = [...rows].sort((a, b) => a.p - b.p);
  const positives = sorted.reduce((a, r) => a + r.y, 0);
  const negatives = sorted.length - positives;
  if (!positives || !negatives) return null;
  let rankSum = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j]!.p === sorted[i]!.p) j += 1;
    const meanRank = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) if (sorted[k]!.y) rankSum += meanRank;
    i = j;
  }
  return (rankSum - (positives * (positives + 1)) / 2) / (positives * negatives);
}

/** Average precision (area under the precision–recall curve, step-wise, ties grouped). */
function auprcOf(rows: RiskRow[]): number | null {
  const sorted = [...rows].sort((a, b) => b.p - a.p);
  const positives = sorted.reduce((a, r) => a + r.y, 0);
  if (!positives) return null;
  let tp = 0;
  let seen = 0;
  let ap = 0;
  let lastRecall = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && sorted[j]!.p === sorted[i]!.p) j += 1;
    for (let k = i; k < j; k += 1) tp += sorted[k]!.y;
    seen += j - i;
    const recall = tp / positives;
    ap += (recall - lastRecall) * (tp / seen);
    lastRecall = recall;
    i = j;
  }
  return ap;
}

/** Patient-level bootstrap 95% interval of a metric (1,000 resamples, seed 42). */
function patientBootstrap(rows: RiskRow[], metric: (rows: RiskRow[]) => number | null): [number, number] | null {
  const byPatient = models.map((_, i) => rows.filter((r) => r.patient === i)).filter((g) => g.length);
  const rand = mulberry32(42);
  const values: number[] = [];
  for (let b = 0; b < 1000; b += 1) {
    const sample: RiskRow[] = [];
    for (let k = 0; k < byPatient.length; k += 1) sample.push(...byPatient[Math.floor(rand() * byPatient.length)]!);
    const value = metric(sample);
    if (value != null) values.push(value);
  }
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const at = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))]!;
  return [round(at(0.025)), round(at(0.975))];
}

// ------------------------------------------------------------------ calibration of the displayed risk
function calibration(kind: "spike" | "low") {
  const horizon = kind === "spike" ? 24 : 12;
  const needValid = kind === "spike" ? 18 : 9;
  const rows: RiskRow[] = [];
  for (const [patient, model] of models.entries()) {
    const prob = kind === "spike" ? model.spikeProb : model.lowProb;
    const n = model.readings.length;
    for (let i = from; i < n - horizon; i += 1) {
      if (blockedForTwin(model, i)) continue;
      const g = model.readings[i]!.glucose!;
      if (kind === "spike" && g > 180) continue;
      if (kind === "low" && g < 70) continue;
      const future: number[] = [];
      for (let k = i + 1; k <= i + horizon; k += 1) {
        const r = model.readings[k];
        if (r && r.glucose != null && !r.cgmGap && !r.compressionLow) future.push(r.glucose);
      }
      if (future.length < needValid) continue;
      const y =
        kind === "spike"
          ? spikeOnset(g, Math.max(...future))
          : lowOnset(g, Math.min(...future), false);
      rows.push({ p: prob[i]!, y: y ? 1 : 0, patient });
    }
  }
  const n = rows.length;
  const base = rows.reduce((a, r) => a + r.y, 0) / n;
  const brier = rows.reduce((a, r) => a + (r.p - r.y) ** 2, 0) / n;
  const reference = base * (1 - base);
  const edges = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0001];
  const reliability = edges.slice(0, -1).map((lo, b) => {
    const hi = edges[b + 1]!;
    const inBin = rows.filter((r) => r.p >= lo && r.p < hi);
    return {
      bin: `${lo.toFixed(2)}–${Math.min(hi, 1).toFixed(2)}`,
      n: inBin.length,
      meanPredicted: inBin.length ? round(inBin.reduce((a, r) => a + r.p, 0) / inBin.length) : null,
      observedRate: inBin.length ? round(inBin.reduce((a, r) => a + r.y, 0) / inBin.length) : null,
    };
  });
  const ece = reliability.reduce(
    (a, b) =>
      a +
      (b.n && b.meanPredicted != null && b.observedRate != null
        ? (b.n / n) * Math.abs(b.meanPredicted - b.observedRate)
        : 0),
    0,
  );
  const shown95 = rows.filter((r) => r.p >= 0.95);
  return {
    target:
      kind === "spike"
        ? "Within the next 120 min glucose goes above 180, or rises 50 mg/dL above now (steps at or under 180 now)"
        : "Within the next 60 min glucose falls under 70 (steps at or over 70 now)",
    steps: n,
    baseRate: round(base),
    brier: round(brier, 4),
    brierClimatology: round(reference, 4),
    brierSkill: round(1 - brier / reference),
    expectedCalibrationError: round(ece),
    auroc: (() => {
      const value = aurocOf(rows);
      return value == null ? null : round(value);
    })(),
    aurocCi: patientBootstrap(rows, aurocOf),
    auprc: (() => {
      const value = auprcOf(rows);
      return value == null ? null : round(value);
    })(),
    auprcCi: patientBootstrap(rows, auprcOf),
    ciMethod: "patient bootstrap, 1000 resamples",
    whenShownAtLeast95: shown95.length
      ? {
          steps: shown95.length,
          observedRate: round(shown95.reduce((a, r) => a + r.y, 0) / shown95.length),
        }
      : null,
    reliability,
  };
}

const calib = { spike: calibration("spike"), low: calibration("low") };

// ------------------------------------------------------------------ write
const out = {
  source: "getCohort() — simulated stress test, mismatched generator (seed 42)",
  patients: models.length,
  evalDays,
  patientDays,
  scorer:
    "scoreAlertEvents: a hit is an alert in the 120 min before a spike (60 min before a low); a false alert has no event in the following window. All methods share hygieneFires (hysteresis, 60-min suppression, 8 alerts/day cap, gaps block).",
  reproducedStoredTwinAlerts: reproduced,
  methods: scores.map(({ leads: _leads, ...rest }) => rest),
  twinLeadHistogram: bins.map(({ label, count }) => ({ label, count })),
  twinThresholdSweep: sweep,
  calibration: calib,
};
mkdirSync(join(root, "reports"), { recursive: true });
writeFileSync(join(root, "reports", "alert_proof.json"), `${JSON.stringify(out, null, 2)}\n`);

const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
const ci = (w: number[] | null) =>
  w ? `${(w[0]! * 100).toFixed(1)}–${(w[1]! * 100).toFixed(1)}%` : "—";
const lead = (s: Score) =>
  s.spike.medianLeadMin == null
    ? "—"
    : `${s.spike.medianLeadMin} (${s.spike.leadIqrMin![0]}–${s.spike.leadIqrMin![1]})`;

const md: string[] = [];
md.push("# Alert proof: warning time against simple alarms");
md.push("");
md.push(
  "Research prototype — not a medical device, not medical advice. Generated by `scripts/alert-proof.ts`; do not hand-edit.",
);
md.push("");
md.push(
  `Data: the simulated stress test (mismatched generator, seed 42), ${models.length} patients × ${evalDays} scored days = ${patientDays} patient-days. ${out.scorer}`,
);
md.push("");
md.push(
  `Rebuilt twin alerts match the stored evaluation: **${reproduced ? "yes" : "NO"}** (${twin.spike.alerts} spike alerts, ${twin.spike.hits} hits of ${twin.spike.events} spikes).`,
);
md.push("");
md.push("## Spike warnings, every method on the same events");
md.push("");
md.push(
  "| Method | Uses | Recall (95% CI) | Precision (95% CI) | F1 | False alerts / patient-day | Median lead, min (IQR) | Warned ≥ 30 min | Warned ≥ 60 min |",
);
md.push("| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const s of scores) {
  md.push(
    `| ${s.label} | ${s.uses} | ${pct(s.spike.recall)} (${ci(s.spike.recallWilson)}) | ${pct(s.spike.precision)} (${ci(s.spike.precisionWilson)}) | ${s.spike.f1} | ${s.spike.falsePerPatientDay} | ${lead(s)} | ${s.spike.warnedAtLeast30.count} (${pct(s.spike.warnedAtLeast30.share)}) | ${s.spike.warnedAtLeast60.count} (${pct(s.spike.warnedAtLeast60.share)}) |`,
  );
}
md.push("");
md.push("## Low warnings");
md.push("");
md.push(
  "| Method | Low events | Alerts | Hits | Recall | Precision | False low alerts / patient-day |",
);
md.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const s of scores) {
  if (!s.low.alerts && s.id.startsWith("carb")) continue;
  md.push(
    `| ${s.label} | ${s.low.events} | ${s.low.alerts} | ${s.low.hits} | ${pct(s.low.recall)} | ${pct(s.low.precision)} | ${s.low.falsePerPatientDay} |`,
  );
}
md.push("");
md.push("## How early the twin warns (spike hits)");
md.push("");
md.push("| Lead time | Spikes |");
md.push("| --- | ---: |");
for (const b of bins) md.push(`| ${b.label} | ${b.count} |`);
md.push(`| Missed (no alert in the 120 min before) | ${twin.spike.events - twin.spike.hits} |`);
md.push("");
md.push("## Twin threshold sweep");
md.push("");
md.push(
  `The live dashboard uses ${LIVE.spike}, chosen on validation days 6–9 by F1; the scored days are never used.`,
);
md.push("");
md.push(
  "| Threshold | Recall | Precision | F1 | False alerts / patient-day | Median lead (min) | Warned ≥ 60 min |",
);
md.push("| ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const r of sweep) {
  md.push(
    `| ${r.threshold} | ${pct(r.recall)} | ${pct(r.precision)} | ${r.f1} | ${r.falsePerPatientDay} | ${r.medianLeadMin ?? "—"} | ${pct(r.warnedAtLeast60Share)} |`,
  );
}
md.push("");
md.push("## Are the displayed risk numbers calibrated?");
md.push("");
for (const kind of ["spike", "low"] as const) {
  const c = calib[kind];
  md.push(
    `**${kind === "spike" ? "Spike" : "Low"} risk.** Target: ${c.target}. ${c.steps} scored 5-min steps, base rate ${pct(c.baseRate)}. Brier ${c.brier} vs ${c.brierClimatology} for always predicting the base rate (skill ${c.brierSkill}). Expected calibration error ${c.expectedCalibrationError}. AUROC ${c.auroc} (95% CI ${c.aurocCi?.join("–") ?? "n/a"}), AUPRC ${c.auprc} (95% CI ${c.auprcCi?.join("–") ?? "n/a"}; base rate ${pct(c.baseRate)}), ${c.ciMethod}.${c.whenShownAtLeast95 ? ` When the risk is ≥ 0.95, the event followed ${pct(c.whenShownAtLeast95.observedRate)} of the time (${c.whenShownAtLeast95.steps} steps).` : ""}`,
  );
  md.push("");
  md.push("| Predicted risk | Steps | Mean predicted | Observed rate |");
  md.push("| --- | ---: | ---: | ---: |");
  for (const r of c.reliability)
    md.push(`| ${r.bin} | ${r.n} | ${r.meanPredicted ?? "—"} | ${r.observedRate ?? "—"} |`);
  md.push("");
}
writeFileSync(join(root, "docs", "ALERT_PROOF.md"), `${md.join("\n")}\n`);

console.log(`reproduced stored twin alerts: ${reproduced}`);
for (const s of scores) {
  console.log(
    `${s.id.padEnd(9)} recall ${pct(s.spike.recall).padStart(6)}  precision ${pct(s.spike.precision).padStart(6)}  F1 ${String(s.spike.f1).padEnd(5)}  false/pd ${String(s.spike.falsePerPatientDay).padEnd(5)}  lead ${lead(s).padEnd(12)}  >=60 ${s.spike.warnedAtLeast60.count}`,
  );
}
console.log("sweep", JSON.stringify(sweep));
console.log("calibration spike", JSON.stringify({ ...calib.spike, reliability: undefined }));
console.log("calibration low", JSON.stringify({ ...calib.low, reliability: undefined }));
