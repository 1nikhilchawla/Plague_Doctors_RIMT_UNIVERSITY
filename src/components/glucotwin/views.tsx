import { Link } from "@tanstack/react-router";
import { Printer } from "lucide-react";
import { useMemo, useState } from "react";
import { AgpChart, GlucoseChart, NightChart } from "@/components/glucotwin/charts";
import { TwoStreamInspector } from "@/components/glucotwin/TwoStreamInspector";
import {
  agp,
  availableIndex,
  clockMs,
  consentModel,
  forecastAt,
  groupLabel,
  isStreamStale,
  nightReview,
  rangeLabel,
  revealOutcome,
  STEPS_PER_DAY,
  traceNow,
  usualMeal,
  weekStats,
  type AblationArm,
  type CohortEval,
  type Group,
  type PatientModel,
  type TraceContributor,
} from "@/lib/glucotwin/cohort";
import { FOODS, PLATES, sumMacros, type PlateItem } from "@/lib/glucotwin/foods";
import {
  formatDayIn,
  formatGlucose,
  formatHours,
  formatWhenIn,
  glucoseUnitLabel,
  type GlucoseUnit,
} from "@/lib/glucotwin/format";
import {
  clinicalNote,
  hba1cPercentToMmol,
  minutesAbove,
  peakOf,
  STEP_MIN,
  type CurvePoint,
} from "@/lib/glucotwin/physics";
import { assignCluster, clusterShift } from "@/lib/glucotwin/clusters";
import { wilson } from "@/lib/glucotwin/ehr";
import { MODEL_VERSION, replayHealth } from "@/lib/glucotwin/engine";
import { getRealEval } from "@/lib/glucotwin/real/adapt";
import { planText, t } from "@/lib/glucotwin/i18n";
import { planDeltas, rankPlans, riskiestSlot, type PlanId } from "@/lib/glucotwin/protocol";
import { useTwinUi, useWard } from "@/lib/glucotwin/store";
import { cn } from "@/lib/utils";
import simEvalFile from "../../../reports/sim_eval.json";

/**
 * The simulated evaluation as committed by `npm run readme:results`. The app
 * shows it instead of re-running the cohort evaluation in the browser.
 */
type SimEvalReport = {
  mismatched: CohortEval;
  matched: CohortEval;
  ablation: AblationArm[];
  streamAblation: AblationArm[];
  lowCost: { pricks: number; rmse: number }[];
  habitLeadMin: number | null;
  habitRecall: number | null;
};

function isSimEvalReport(value: unknown): value is SimEvalReport {
  return (
    typeof value === "object" &&
    value !== null &&
    "mismatched" in value &&
    "matched" in value &&
    "streamAblation" in value &&
    Array.isArray(value.streamAblation) &&
    "lowCost" in value &&
    Array.isArray(value.lowCost)
  );
}

function checkedSimEval(value: unknown): SimEvalReport {
  if (!isSimEvalReport(value))
    throw new Error("reports/sim_eval.json is not a simulated evaluation report");
  return value;
}

const simEval = checkedSimEval(simEvalFile);

function Spark({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values, 70);
  const max = Math.max(...values, 180);
  const d = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 96;
      const y = 28 - ((value - min) / Math.max(1, max - min)) * 24;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox="0 0 96 32" className="h-8 w-24" aria-hidden="true">
      <path d={d} fill="none" stroke="var(--color-teal)" strokeWidth="1.75" />
    </svg>
  );
}

function lookReason(stale: boolean, flag: number, risk: number | null): string {
  if (stale) return "Stream is behind the ward clock.";
  if ((flag & 8) !== 0) return "Urgent low. Only urgent alerts interrupt.";
  if ((flag & 4) !== 0) return "Urgent spike. Only urgent alerts interrupt.";
  if ((flag & 2) !== 0 || (flag & 1) !== 0)
    return "Watch only. It stays in the list and does not interrupt.";
  if (risk != null && risk >= 0.4) return `Risk ${Math.round(risk * 100)}%, not firing yet.`;
  return "Quiet at this minute.";
}

export function CohortView() {
  const ward = useWard();
  const wardIndex = useTwinUi((state) => state.wardIndex);
  const unit = useTwinUi((state) => state.unit);
  const consent = useTwinUi((state) => state.consent);
  const [filter, setFilter] = useState<Group | "all">("all");
  // The ranking uses each patient's consented twin, as the patient pages do.
  const patients = useMemo(
    () => ward.patients.map((model) => consentModel(model, consent[model.patient.id])),
    [ward, consent],
  );
  const rows = patients
    .filter((model) => filter === "all" || model.patient.group === filter)
    .map((model) => {
      const stale = isStreamStale(model, wardIndex);
      const index = availableIndex(model, wardIndex);
      const glucose = model.readings[index]?.glucose ?? null;
      const risk = stale ? null : Math.max(model.spikeProb[index] ?? 0, model.lowProb[index] ?? 0);
      const week = weekStats(model, index, 7);
      const trace = stale ? null : traceNow(model, index);
      const hidden = trace?.unlogged.reduce((sum, item) => sum + item.mgdl, 0) ?? 0;
      const dawn = nightReview(model, index).rows.find((row) => row.rise != null)?.rise ?? null;
      const spark: number[] = [];
      for (let cursor = Math.max(0, index - 7 * 288); cursor <= index; cursor += 6) {
        const value = model.readings[cursor]?.glucose;
        if (value != null && !model.readings[cursor]?.compressionLow) spark.push(value);
      }
      return {
        model,
        stale,
        glucose,
        risk,
        week,
        spark,
        hidden,
        dawn,
        flag: model.active[index] ?? 0,
        reason: lookReason(stale, model.active[index] ?? 0, risk),
      };
    })
    .sort((a, b) => (b.risk ?? -1) - (a.risk ?? -1));
  const real = ward.source === "cgmacros";

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="font-display text-3xl text-ink">
          {real ? "CGMacros cohort" : "Ward cohort"}
        </h1>
        <p className="mt-1 max-w-2xl text-pretty text-muted">
          {real
            ? "Three held-out CGMacros participants, one from each HbA1c group. Glucose, meals, and watch METs are from the study. Dates are shifted. No sleep stream."
            : `${ward.patients.length} simulated patients, ranked by who needs a look at this minute. Every stream is synthetic. Urgent alerts interrupt; Watch stays on the list. Suresh’s wearable is 45 minutes behind, so his forecast stays off.`}
        </p>
      </div>
      <div className="flex gap-2 overflow-x-auto">
        {(
          [
            ["all", "All"],
            ["t2d", "Type 2"],
            ["prediabetes", "Prediabetes"],
            ["healthy", "No diabetes"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setFilter(id)}
            className={cn(
              "h-10 shrink-0 rounded-full px-4 text-sm font-semibold",
              filter === id ? "bg-ink text-paper" : "border border-line bg-surface text-ink",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map(({ model, stale, glucose, risk, week, spark, flag, hidden, dawn, reason }) => (
          <li key={model.patient.id}>
            <Link
              to="/"
              search={{ patient: model.patient.id, tab: "twin" }}
              className="grid gap-3 rounded-2xl border border-line bg-surface p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-display text-xl">{model.patient.name}</h2>
                  <span className="rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted">
                    {groupLabel(model.patient.group)}
                  </span>
                  {model.patient.cluster !== "none" ? (
                    <span className="rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted">
                      {model.patient.cluster} · approximate
                    </span>
                  ) : null}
                  <span className="rounded-full bg-amber-soft px-2 py-0.5 text-xs font-semibold text-amber">
                    {model.patient.simulated ? "Simulated" : "CGMacros"}
                  </span>
                  {(flag & 8) !== 0 && !stale ? (
                    <span className="rounded-full bg-indigo-soft px-2 py-0.5 text-xs font-semibold text-indigo">
                      Urgent low
                    </span>
                  ) : (flag & 2) !== 0 && !stale ? (
                    <span className="rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted">
                      Watch low
                    </span>
                  ) : null}
                  {(flag & 4) !== 0 && !stale ? (
                    <span className="rounded-full bg-amber-soft px-2 py-0.5 text-xs font-semibold text-amber">
                      Urgent spike
                    </span>
                  ) : (flag & 1) !== 0 && !stale ? (
                    <span className="rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted">
                      Watch
                    </span>
                  ) : null}
                  {hidden >= 4 ? (
                    <span className="rounded-full bg-amber-soft px-2 py-0.5 text-xs font-semibold text-amber">
                      Hidden snack
                    </span>
                  ) : null}
                  {dawn != null && dawn >= 15 ? (
                    <span className="rounded-full bg-amber-soft px-2 py-0.5 text-xs font-semibold text-amber">
                      Dawn +{Math.round(dawn)}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-sm text-muted">
                  {reason} {model.patient.age}
                  {model.patient.sex === "F" ? "F" : "M"} · BMI {model.patient.bmi} · HbA1c{" "}
                  {model.patient.hba1c}%{model.patient.onMetformin ? " · Metformin" : ""}
                </p>
              </div>
              <div className="flex items-center justify-between gap-4 sm:justify-end">
                <Spark values={spark} />
                <div className="text-right">
                  <p className="font-display text-2xl tabular-nums">
                    {glucose == null ? "—" : formatGlucose(glucose, unit)}
                    <span className="ml-1 text-xs font-sans font-medium text-muted">
                      {glucoseUnitLabel(unit)}
                    </span>
                  </p>
                  <p className="text-xs text-muted">
                    {stale ? "Stale stream" : `Risk ${Math.round((risk ?? 0) * 100)}%`} · TIR{" "}
                    {Math.round(week.tir)}%
                  </p>
                  <p className="mt-1 flex items-center justify-end gap-1 text-xs font-semibold">
                    <span className={cn("size-2 rounded-full", stale ? "bg-amber" : "bg-teal")} />
                    {stale ? `${model.patient.lagSteps * 5} min behind` : "Live"}
                  </p>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
      <Evidence />
    </div>
  );
}

function Evidence() {
  const cohort = simEval;
  const patients = useWard().patients;
  const real = getRealEval();
  const hybridLine = (["30", "60", "120"] as const)
    .map((horizon) => {
      const row = real.hybrid[horizon];
      if (!row) return "";
      const decision = row.kept ? "kept" : "not kept";
      return `+${horizon} min ${decision}: cross-validated twin ${row.rmseTwin} vs hybrid ${row.rmseHybrid}; held-out 3 twin ${row.heldoutTwin} vs hybrid ${row.heldoutHybrid}`;
    })
    .join(". ");
  return (
    <section className="flex flex-col gap-4">
      <FitBlock
        title="CGMacros — real"
        note={`${real.note} The curves on these three participants are the mechanistic twin, not the LightGBM residual. ${real.participants} participants (healthy ${real.groupCounts.healthy}, prediabetes ${real.groupCounts.prediabetes}, type 2 ${real.groupCounts.t2d}). DOI ${real.doi}. ${real.licence}.`}
        evalResult={real}
        windowNote={`60-min patient RMSE mean ${real.horizons[1]?.patientRmseMean} (95% bootstrap CI ${real.horizons[1]?.patientRmseCi[0]}–${real.horizons[1]?.patientRmseCi[1]}). RMSE is mg/dL. Days 7 through the end of each file. 30-min linear extrapolation RMSE ${real.horizons.map((row) => `${row.horizonMin} min ${row.rmseLinear}`).join(", ")}. LightGBM on the residual, GroupKFold, demo subjects held out: ${hybridLine}. Research prototype — not a medical device, not medical advice.`}
      />
      <FitBlock
        title="Mismatched generator — stress test"
        note="This is the stream on the simulated ward. Meals follow a gamma absorption curve the twin does not use, sensitivity drifts, the sensor lags, and logged carbs are noisy. Reported simulated alerts use this generator. Simulated, not a clinical result."
        evalResult={cohort.mismatched}
        windowNote={`60-min patient RMSE mean ${cohort.mismatched.horizons[1]?.patientRmseMean} (95% bootstrap CI ${cohort.mismatched.horizons[1]?.patientRmseCi[0]}–${cohort.mismatched.horizons[1]?.patientRmseCi[1]}). RMSE is mg/dL. Days 10–21. Research prototype — not a medical device, not medical advice.`}
      />
      <FitBlock
        title="Matched generator — upper bound"
        note="Same meal and walk curve the twin uses, plus noise and the scripted gaps. This is an upper bound on this simulator, not a CGMacros result."
        evalResult={cohort.matched}
        windowNote={`60-min patient RMSE mean ${cohort.matched.horizons[1]?.patientRmseMean} (95% bootstrap CI ${cohort.matched.horizons[1]?.patientRmseCi[0]}–${cohort.matched.horizons[1]?.patientRmseCi[1]}). RMSE is mg/dL. Days 10–21. Research prototype — not a medical device, not medical advice.`}
      />
      <AblationBlock
        title="Cold start — simulated mismatched stream"
        note="Same days 10–21 as the stress test. No EHR is one prior for everyone. Group only is the diagnosis prior with no CGM fit. Record + cluster is the lab formula plus an approximate INSPIRED-style shift — a modelling assumption, not the hidden generator knobs, and not the published clustering method. Personal calibration shrinks the day 1–5 CGM estimate toward that record prior; that last row is the live curve, which falls back to the group prior for a patient where the record did not clearly help on validation days."
        arms={cohort.ablation}
      />
      {real.ablation ? (
        <AblationBlock
          title="Cold start — CGMacros"
          note="Leave-one-out ridge from HbA1c, fasting glucose, fasting insulin, HOMA-IR, BMI, age, and sex. The target is that person’s day 1–4 knob estimate. The held-out person does not train their own prior. The approximate cluster is labelled on the twin card and does not shift this ridge."
          arms={real.ablation}
        />
      ) : null}
      <AblationBlock
        title="Drop one stream — simulated"
        note="Same fitted twin and the same days 10–21. Each row hides one input. No record keeps the personal fit, shrunk toward the group prior, without the medicine term; the next row also drops the personal fit. No sleep holds every night at 8 hours. This is a stress test, not a claim that a missing stream is safe."
        arms={cohort.streamAblation}
      />
      <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
        <h2 className="font-display text-2xl">Low-cost sensing — simulated</h2>
        <p className="mt-1 text-sm text-pretty text-muted">
          Nested finger-pricks, linearly filled, scored against the full CGM on days 10–21. 288
          means every 5 minutes. A full stream has RMSE 0 against itself. More pricks are not
          guaranteed to lower the error.
        </p>
        <ul className="mt-3 grid gap-2 sm:grid-cols-5">
          {cohort.lowCost.map((row) => (
            <li key={row.pricks} className="rounded-xl bg-paper p-3 text-sm tabular-nums">
              <p className="text-xs text-muted">
                {row.pricks === 288 ? "Full CGM" : `${row.pricks} / day`}
              </p>
              <p className="font-display text-2xl">{row.rmse}</p>
              <p className="text-xs text-muted">RMSE mg/dL</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-sm text-muted">
          {cohort.habitRecall === cohort.mismatched.alerts.spikeRecall &&
          cohort.habitLeadMin === cohort.mismatched.alerts.medianLeadMin
            ? `Usual-meal prior did not move spike recall (${pct(cohort.habitRecall)}) or median lead (${cohort.habitLeadMin ?? "—"} min) on this stress test. The stress-test row above is the number to quote.`
            : `Usual-meal prior: spike recall ${pct(cohort.habitRecall)}, median lead ${cohort.habitLeadMin ?? "—"} min. Without it, recall is ${pct(cohort.mismatched.alerts.spikeRecall)} and median lead is ${cohort.mismatched.alerts.medianLeadMin ?? "—"} min.`}
        </p>
      </section>
      <PersonalGain patients={patients} />
    </section>
  );
}

function PersonalGain({ patients }: { patients: PatientModel[] }) {
  const rows = [...patients].sort(
    (a, b) => a.fit.rmse60 - a.fit.rmse60Pop - (b.fit.rmse60 - b.fit.rmse60Pop),
  );
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h2 className="font-display text-2xl">Personal gain — simulated</h2>
      <p className="mt-1 text-sm text-pretty text-muted">
        60-min RMSE on days 10–21. Gain is the group prior minus the personal fit. A negative gain
        means the personal fit is worse for that person. Simulated, not a clinical result.
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-2 pr-3 font-semibold">Person</th>
              <th className="py-2 pr-3 font-semibold">Personal</th>
              <th className="py-2 pr-3 font-semibold">Group</th>
              <th className="py-2 font-semibold">Gain</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((model) => {
              const gain = Math.round((model.fit.rmse60Pop - model.fit.rmse60) * 10) / 10;
              return (
                <tr key={model.patient.id} className="border-t border-line tabular-nums">
                  <td className="py-2 pr-3">
                    {model.patient.name}
                    <span className="ml-2 text-xs text-muted">
                      {model.patient.cluster === "none" ? "no cluster" : model.patient.cluster}
                    </span>
                  </td>
                  <td className="py-2 pr-3">{model.fit.rmse60}</td>
                  <td className="py-2 pr-3">{model.fit.rmse60Pop}</td>
                  <td className="py-2">
                    {gain > 0 ? `+${gain}` : gain}
                    {gain < 0 ? " · worse" : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function AblationBlock({
  title,
  note,
  arms,
}: {
  title: string;
  note: string;
  arms: { id: string; label: string; rmse60: number; n: number }[];
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mt-1 text-sm text-pretty text-muted">{note}</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[28rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-2 pr-3 font-semibold">Arm</th>
              <th className="py-2 pr-3 font-semibold">60-min RMSE</th>
              <th className="py-2 font-semibold">Points</th>
            </tr>
          </thead>
          <tbody>
            {arms.map((arm) => (
              <tr key={arm.id} className="border-t border-line tabular-nums">
                <td className="py-2 pr-3">{arm.label}</td>
                <td className="py-2 pr-3">{arm.rmse60}</td>
                <td className="py-2">{arm.n}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function FitBlock({
  title,
  note,
  evalResult,
  windowNote,
}: {
  title: string;
  note: string;
  evalResult: {
    horizons: Array<{
      horizonMin: number;
      rmseTwin: number;
      rmsePersistence: number;
      rmsePopulation: number;
      improvementPct: number;
      coverage: number;
      clarkeApb: number | null;
    }>;
    groups: Array<{
      group: Group;
      rmse60: number;
      rmse60Persistence: number;
      improvementPct: number;
    }>;
    alerts: {
      spikeEvents: number;
      spikeAlerts: number;
      spikeRecall: number | null;
      spikePrecision: number | null;
      lowEvents: number;
      lowAlerts: number;
      lowRecall: number | null;
      lowPrecision: number | null;
      falsePerPatientDay: number;
      medianLeadMin: number | null;
      leadIqrMin: [number, number] | number[] | null;
      urgentAlerts?: number;
      urgentRecall?: number | null;
      urgentPrecision?: number | null;
      urgentPerPatientDay?: number;
      watchPerPatientDay?: number;
      urgentHits?: number;
      urgentTrue?: number;
    };
  };
  windowNote: string;
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
      <h2 className="font-display text-2xl">{title}</h2>
      <p className="mt-1 text-sm text-pretty text-muted">{note}</p>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[36rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-2 pr-3 font-semibold">Horizon</th>
              <th className="py-2 pr-3 font-semibold">RMSE twin</th>
              <th className="py-2 pr-3 font-semibold">Persistence</th>
              <th className="py-2 pr-3 font-semibold">Population</th>
              <th className="py-2 pr-3 font-semibold">Vs persistence</th>
              <th className="py-2 pr-3 font-semibold">Band coverage</th>
              <th className="py-2 font-semibold">Clarke A+B</th>
            </tr>
          </thead>
          <tbody>
            {evalResult.horizons.map((row) => (
              <tr key={row.horizonMin} className="border-t border-line tabular-nums">
                <td className="py-2 pr-3">{row.horizonMin} min</td>
                <td className="py-2 pr-3">{row.rmseTwin}</td>
                <td className="py-2 pr-3">{row.rmsePersistence}</td>
                <td className="py-2 pr-3">{row.rmsePopulation}</td>
                <td className="py-2 pr-3">{row.improvementPct}%</td>
                <td className="py-2 pr-3">{Math.round(row.coverage * 1000) / 10}%</td>
                <td className="py-2">
                  {row.clarkeApb == null ? "—" : `${Math.round(row.clarkeApb * 1000) / 10}%`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">{windowNote}</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {evalResult.groups.map((group) => (
          <div key={group.group} className="rounded-xl bg-paper p-3">
            <p className="text-xs font-semibold text-muted">{groupLabel(group.group)}</p>
            <p className="mt-1 text-sm tabular-nums">
              60-min RMSE {group.rmse60} vs persistence {group.rmse60Persistence} (
              {group.improvementPct}%)
            </p>
          </div>
        ))}
      </div>
      <p className="mt-4 text-sm text-pretty text-muted">
        Spike episodes {evalResult.alerts.spikeEvents}, alerts {evalResult.alerts.spikeAlerts},
        recall {pct(evalResult.alerts.spikeRecall)}, precision{" "}
        {pct(evalResult.alerts.spikePrecision)}. Low episodes {evalResult.alerts.lowEvents}, alerts{" "}
        {evalResult.alerts.lowAlerts}, recall {pct(evalResult.alerts.lowRecall)}, precision{" "}
        {pct(evalResult.alerts.lowPrecision)}. False alerts {evalResult.alerts.falsePerPatientDay}{" "}
        per patient-day. Median lead {evalResult.alerts.medianLeadMin ?? "—"} min
        {evalResult.alerts.leadIqrMin
          ? ` (IQR ${evalResult.alerts.leadIqrMin[0]}–${evalResult.alerts.leadIqrMin[1]})`
          : ""}
        .
      </p>
      {evalResult.alerts.urgentAlerts != null ? (
        <p className="mt-2 text-sm text-pretty text-muted">
          Urgent alerts {evalResult.alerts.urgentAlerts} (
          {evalResult.alerts.urgentPerPatientDay ?? "—"} per patient-day), recall{" "}
          {pct(evalResult.alerts.urgentRecall ?? null)}, precision{" "}
          {pct(evalResult.alerts.urgentPrecision ?? null)}. Watch{" "}
          {evalResult.alerts.watchPerPatientDay ?? "—"} per patient-day. Only Urgent interrupts the
          ward.
        </p>
      ) : null}
      <WilsonLine alerts={evalResult.alerts} />
    </section>
  );
}

function WilsonLine({
  alerts,
}: {
  alerts: {
    spikeHits?: number;
    spikeEvents: number;
    spikeTrue?: number;
    spikeAlerts: number;
    lowHits?: number;
    lowEvents: number;
    lowTrue?: number;
    lowAlerts: number;
    urgentHits?: number;
    urgentTrue?: number;
    urgentAlerts?: number;
  };
}) {
  if (alerts.spikeHits == null || alerts.spikeTrue == null) return null;
  const spikeRecall = wilson(alerts.spikeHits, alerts.spikeEvents);
  const spikePrecision = wilson(alerts.spikeTrue, alerts.spikeAlerts);
  const lowRecall = alerts.lowHits == null ? null : wilson(alerts.lowHits, alerts.lowEvents);
  const lowPrecision = alerts.lowTrue == null ? null : wilson(alerts.lowTrue, alerts.lowAlerts);
  const band = (interval: [number, number] | null) =>
    interval ? `${pct(interval[0])}–${pct(interval[1])}` : "—";
  return (
    <p className="mt-2 text-xs text-muted">
      Wilson 95% intervals. Spike recall {band(spikeRecall)}, precision {band(spikePrecision)}. Low
      recall {band(lowRecall)}, precision {band(lowPrecision)}.
      {alerts.urgentHits != null && alerts.urgentTrue != null && alerts.urgentAlerts != null
        ? ` Urgent recall ${band(wilson(alerts.urgentHits, alerts.spikeEvents + alerts.lowEvents))}, precision ${band(wilson(alerts.urgentTrue, alerts.urgentAlerts))}.`
        : ""}
    </p>
  );
}

function zoneOf(model: PatientModel): string {
  return model.patient.simulated ? "Asia/Kolkata" : "UTC";
}

function whenLabel(model: PatientModel, index: number): string {
  return `${formatWhenIn(clockMs(model, index), zoneOf(model))} ${model.patient.simulated ? "IST" : "shifted"}`;
}

function dayLabel(model: PatientModel, index: number): string {
  return formatDayIn(clockMs(model, index), zoneOf(model));
}

function pct(value: number | null): string {
  if (value == null) return "—";
  return `${Math.round(value * 1000) / 10}%`;
}

function ConsentPanel({ model }: { model: PatientModel }) {
  const consent = useTwinUi((state) => state.consent[model.patient.id]) ?? {
    ehr: true,
    wearable: true,
  };
  const setConsent = useTwinUi((state) => state.setConsent);
  // Same widening as consentBands in cohort.ts: at least x1.12.
  const ratio =
    model.fit.rmse60 > 0 ? Math.max(1.12, model.fit.rmse60Pop / model.fit.rmse60) : 1.12;
  const streams: { key: "ehr" | "wearable"; label: string; off: string }[] = [
    {
      key: "ehr",
      label: "Health record (FHIR R4)",
      off: `Withdrawn: the twin drops the record prior and the medicine list, keeps its personal CGM fit shrunk toward the ${groupLabel(model.patient.group)} group prior, and the band widens ×${ratio.toFixed(2)}. Alerts and plans follow.`,
    },
    {
      key: "wearable",
      label: "Wearables (sleep, HRV, activity)",
      off: "Withdrawn: no sleep, HRV or walk adjustment; the band widens ×1.10. Glucose (CGM) stays on.",
    },
  ];
  return (
    <div className="mb-3 rounded-xl border border-line bg-paper p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">
        Stream consent (DPDP-style, per stream)
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {streams.map((stream) => {
          const allowed = consent[stream.key];
          return (
            <button
              key={stream.key}
              type="button"
              role="switch"
              aria-checked={allowed}
              onClick={() => setConsent(model.patient.id, stream.key, !allowed)}
              className={cn(
                "h-9 rounded-full border px-3 text-xs font-semibold",
                allowed
                  ? "border-teal bg-teal-soft text-teal"
                  : "border-amber bg-amber-soft text-amber",
              )}
            >
              {stream.label}: {allowed ? "consented" : "withdrawn"}
            </button>
          );
        })}
      </div>
      {streams
        .filter((stream) => !consent[stream.key])
        .map((stream) => (
          <p key={stream.key} className="mt-2 text-xs text-amber">
            {stream.off}
          </p>
        ))}
    </div>
  );
}

export function TwinView({ model }: { model: PatientModel }) {
  const unit = useTwinUi((state) => state.unit);
  const wardIndex = useTwinUi((state) => state.wardIndex);
  const index = availableIndex(model, wardIndex);
  const stale = isStreamStale(model, wardIndex);
  const reading = model.readings[index];
  const glucose = reading?.glucose ?? null;
  const range = rangeLabel(glucose);
  const flag = model.active[index] ?? 0;
  const lagMin = (wardIndex - index) * STEP_MIN;
  const homa = model.patient.homaIr;
  const recentMeals = model.meals.filter((meal) => {
    const mealIndex = Math.round(meal.min / STEP_MIN);
    return meal.logged && mealIndex <= index && index - mealIndex <= 72;
  });

  return (
    <div className="flex flex-col gap-4">
      {stale ? (
        <p className="rounded-xl bg-amber-soft px-4 py-3 text-sm font-medium text-ink">
          Stream is {lagMin} min behind the ward clock. Forecasts and new alerts are paused until a
          fresh CGM point arrives.
        </p>
      ) : null}
      {(flag & 8) !== 0 && !stale ? (
        <p className="rounded-xl bg-indigo-soft px-4 py-3 text-sm font-semibold text-indigo">
          Urgent low. Only urgent alerts interrupt.
        </p>
      ) : null}
      {(flag & 4) !== 0 && (flag & 8) === 0 && !stale ? (
        <p className="rounded-xl bg-amber-soft px-4 py-3 text-sm font-semibold text-amber">
          Urgent spike. A watch-level rise stays on the alert list and does not interrupt.
        </p>
      ) : null}
      {model.patient.meds.some((med) => med.toLowerCase().includes("sulfonylurea")) ? (
        <p className="rounded-xl bg-paper px-4 py-3 text-sm text-ink">
          Simulated sulfonylurea from day 16. The generator applies its documented carb cut and can
          skip dinner, and it subtracts a modelling-assumption offset when a meal is late. The twin
          reads the medicine from the record: from day 16 it expects glucose to fall during long
          gaps after a meal and smaller meal rises.
          {model.patient.sulfonylureaFromDay == null
            ? " The record is withdrawn, so this twin does not know about the medicine."
            : ""}
          {model.driftStart == null
            ? " This change did not hold 35% of a rolling 12 hours outside the 30-minute band for 6 hours, so the drift chip is not this person."
            : " The drift rule did mark this stream."}{" "}
          Simulation, not advice.
        </p>
      ) : null}
      {model.driftStart != null &&
      index >= model.driftStart &&
      (model.driftRecovered == null || index < model.driftRecovered) ? (
        <p className="rounded-xl bg-amber-soft px-4 py-3 text-sm font-medium text-ink">
          Twin out of sync since {whenLabel(model, model.driftStart)}. More than 35% of a rolling 12
          hours sat outside the band that was forecast 30 minutes earlier, and that stayed true for
          6 hours. Recovery would re-estimate the last 3 days. This curve still uses the original
          fit, so the published error table does not move. Simulation, not advice.
        </p>
      ) : null}
      <section className="grid gap-4 rounded-2xl border border-line bg-surface p-4 lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-3xl">{model.patient.name}</h1>
            <span className="rounded-full bg-amber-soft px-2 py-0.5 text-xs font-semibold text-amber">
              {model.patient.simulated ? "Simulated" : "CGMacros"}
            </span>
          </div>
          <p className="mt-1 text-sm text-muted">
            {model.patient.id} · {model.patient.age}
            {model.patient.sex} · {groupLabel(model.patient.group)}
          </p>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <Fact label="BMI" value={String(model.patient.bmi)} />
            <Fact
              label="HbA1c"
              value={`${model.patient.hba1c}% · ${Math.round(hba1cPercentToMmol(model.patient.hba1c))} mmol/mol`}
            />
            <Fact
              label="Fasting glucose"
              value={
                model.patient.fastingGlucose == null ? "—" : `${model.patient.fastingGlucose} mg/dL`
              }
            />
            <Fact label="HOMA-IR" value={homa == null ? "—" : homa.toFixed(1)} />
            <Fact
              label="Metformin"
              value={
                model.patient.simulated
                  ? model.patient.onMetformin
                    ? "Yes"
                    : "No"
                  : "Not in this record"
              }
            />
            <Fact
              label="TCF7L2 alleles"
              value={
                model.patient.simulated
                  ? `${model.patient.alleles} · simulated`
                  : "Not in this record"
              }
            />
          </dl>
          <p className="mt-3 text-sm text-muted">
            {model.patient.diagnoses.length
              ? model.patient.diagnoses.join(", ")
              : "No diabetes diagnosis"}
            {model.patient.meds.length ? ` · ${model.patient.meds.join(", ")}` : ""}
          </p>
          <p className="mt-2 text-xs text-muted">
            HbA1c trail, all before the stream:{" "}
            {model.patient.hba1cHistory.map((row) => `${row.when} ${row.percent}%`).join(" · ")}
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">Glucose now</p>
          <p className="font-display text-5xl tabular-nums">
            {glucose == null ? "—" : formatGlucose(glucose, unit)}
            <span className="ml-2 text-base font-sans text-muted">{glucoseUnitLabel(unit)}</span>
          </p>
          <p
            className={cn(
              "mt-1 inline-flex rounded-full px-2 py-0.5 text-sm font-semibold",
              range === "Below range" && "bg-indigo-soft text-indigo",
              range === "Above range" && "bg-amber-soft text-amber",
              range === "In range" && "bg-teal-soft text-teal",
              range === "No reading" && "bg-paper text-muted",
            )}
          >
            {range}
          </p>
          <p className="mt-1 text-xs text-muted">
            Last sample {whenLabel(model, index)} ·{" "}
            {model.patient.simulated
              ? "Dexcom unless a gap is marked"
              : `Dexcom, Libre only in gaps after a ${model.libreOffset ?? "—"} mg/dL offset`}
          </p>
        </div>
      </section>
      <section className="rounded-2xl border border-line bg-surface p-4">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-2xl">Last 6 hours and 2-hour forecast</h2>
          <p className="text-xs text-muted">
            Dashed teal is the median. The wash is the 10th–90th band. Amber dots are meals, teal
            triangles are walks.
          </p>
        </div>
        <ConsentPanel model={model} />
        <GlucoseChart model={model} wardIndex={wardIndex} unit={unit} />
      </section>
      <section className="grid gap-3 sm:grid-cols-4">
        <Param
          label="Carb sensitivity"
          value={`${model.params.carbSensitivity.toFixed(1)} mg/dL`}
          detail="per 10 g, shrunk to the group"
        />
        <Param
          label="Activity effect"
          value={`${model.params.activityEffect.toFixed(1)} mg/dL`}
          detail="drop per 30 min walking"
        />
        <Param
          label="Fasting baseline"
          value={`${Math.round(model.params.fastingBaseline)} mg/dL`}
          detail={
            model.patient.simulated
              ? "median 03:00–06:00, first 5 days"
              : "median 03:00–06:00, days 1–4"
          }
        />
        <Param
          label="Recovery"
          value={model.params.recoveryMin == null ? "—" : `${model.params.recoveryMin} min`}
          detail={`${model.params.isolatedMeals} isolated meals`}
        />
      </section>
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-display text-xl">What the record contributes</h2>
        <ClusterLine model={model} />
        <p className="mt-1 text-sm text-pretty text-muted">
          The record column is a cold start from labs
          {model.patient.simulated ? " plus the approximate cluster shift" : ""}. It does not read
          the hidden generator. The live curve uses the fitted column, which shrinks toward{" "}
          {model.params.prior === "record"
            ? "this record prior"
            : "the group prior (the record-based twin was not clearly better on validation days)"}
          . Dawn and recovery on the live curve stay on the HbA1c group.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[22rem] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="py-2 pr-3 font-semibold">Knob</th>
                <th className="py-2 pr-3 font-semibold">Record</th>
                <th className="py-2 pr-3 font-semibold">Fitted</th>
                <th className="py-2 font-semibold">Group</th>
              </tr>
            </thead>
            <tbody className="tabular-nums">
              <tr className="border-t border-line">
                <td className="py-2 pr-3">Carb, per 10 g</td>
                <td className="py-2 pr-3">{model.ehrKnobs.carbSensitivity.toFixed(1)}</td>
                <td className="py-2 pr-3">{model.params.knobs.carbSensitivity.toFixed(1)}</td>
                <td className="py-2">{model.popKnobs.carbSensitivity.toFixed(1)}</td>
              </tr>
              <tr className="border-t border-line">
                <td className="py-2 pr-3">Activity, per 30 min</td>
                <td className="py-2 pr-3">{model.ehrKnobs.activityEffect.toFixed(1)}</td>
                <td className="py-2 pr-3">{model.params.knobs.activityEffect.toFixed(1)}</td>
                <td className="py-2">{model.popKnobs.activityEffect.toFixed(1)}</td>
              </tr>
              <tr className="border-t border-line">
                <td className="py-2 pr-3">Fasting, mg/dL</td>
                <td className="py-2 pr-3">{Math.round(model.ehrKnobs.fastingBaseline)}</td>
                <td className="py-2 pr-3">{Math.round(model.params.knobs.fastingBaseline)}</td>
                <td className="py-2">{Math.round(model.popKnobs.fastingBaseline)}</td>
              </tr>
              <tr className="border-t border-line">
                <td className="py-2 pr-3">Dawn, mg/dL</td>
                <td className="py-2 pr-3">{Math.round(model.ehrKnobs.dawnAmp)}</td>
                <td className="py-2 pr-3">{Math.round(model.params.knobs.dawnAmp)}</td>
                <td className="py-2">{Math.round(model.popKnobs.dawnAmp)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-muted">
          {model.patient.simulated
            ? "Simulated formula: carb starts at 3.1 and rises 1.35 per HbA1c point above 5, plus a small HOMA, sex, and TCF7L2 allele term (0.35 per allele, a modelling assumption), plus seeded noise. The cluster shift is applied after that. Fasting mixes the lab fasting glucose with an HbA1c line. Dawn and tau on the live curve are estimated from the first 5 days and shrunk toward the group."
            : model.patient.diagnoses.some((line) => line.includes("leave-one-out ridge"))
              ? "This CGMacros prior is a leave-one-out ridge on HbA1c, fasting glucose, fasting insulin, HOMA-IR, BMI, age, and sex. The person was not in their own training fold."
              : "This CGMacros prior is the documented lab formula. A leave-one-out ridge replaces it once that file is loaded."}{" "}
          Research prototype — not a medical device, not medical advice.
        </p>
        <p className="mt-2 text-xs text-muted">
          Sources. Labs and the TCF7L2 count are{" "}
          {model.patient.simulated ? "simulated" : "from the CGMacros record (no genotype)"}.
          Cluster is approximate, not the published method. Sleep stages and step counts are{" "}
          {model.nights[0]?.stages
            ? "a simulated Apple Health-shaped export"
            : "not in this record"}
          .
        </p>
      </section>
      <TwinHealthPanel model={model} index={index} />
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-display text-xl">Logged intake in the last 6 hours</h2>
        {recentMeals.length === 0 ? (
          <p className="mt-2 text-sm text-muted">No logged meal in this window.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {recentMeals.map((meal) => (
              <li key={meal.id} className="text-sm">
                <span className="font-semibold tabular-nums">
                  {whenLabel(model, Math.round(meal.min / STEP_MIN))}
                </span>
                <span className="text-muted">
                  {" "}
                  · {Math.round(meal.carbs)} g carbs · {meal.name}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-muted">
          Personal 60-min RMSE {model.fit.rmse60} mg/dL versus population {model.fit.rmse60Pop}{" "}
          mg/dL on the later days of this stream.
        </p>
        <div className="mt-1 flex flex-wrap gap-x-4">
          <Link
            to="/"
            search={{ patient: model.patient.id, tab: "split" }}
            className="inline-flex h-11 items-center text-sm font-semibold text-teal"
          >
            Open the glucose split
          </Link>
          <Link
            to="/"
            search={{ patient: model.patient.id, tab: "night" }}
            className="inline-flex h-11 items-center text-sm font-semibold text-teal"
          >
            Open the overnight
          </Link>
        </div>
      </section>
      <TwoStreamInspector model={model} index={index} lagMin={lagMin} />
    </div>
  );
}

function ClusterLine({ model }: { model: PatientModel }) {
  const assigned = assignCluster({
    hba1c: model.patient.hba1c,
    bmi: model.patient.bmi,
    age: model.patient.age,
    fastingGlucose: model.patient.fastingGlucose,
    fastingInsulin: model.patient.fastingInsulin,
    triglycerides: model.patient.triglycerides,
    hdl: model.patient.hdl,
  });
  const shift = clusterShift(assigned.id);
  const name = assigned.id === "none" ? "No type 2 cluster" : assigned.id;
  const sign = (value: number) => `${value >= 0 ? "+" : ""}${value}`;
  return (
    <div className="mt-3 rounded-xl bg-paper p-3 text-sm">
      <p className="font-semibold">{name} · approximate, not the published method</p>
      <p className="mt-1 text-pretty text-muted">{model.patient.clusterNote}</p>
      <p className="mt-2 text-xs text-muted">
        {assigned.fields.join(" · ")}. Lipids are shown and are not used in the rule.
      </p>
      <p className="mt-2 text-xs text-muted tabular-nums">
        Cluster shift, modelling assumption: carb {sign(shift.carbSensitivity)}, activity{" "}
        {sign(shift.activityEffect)}, fasting {sign(shift.fastingBaseline)}, dawn{" "}
        {sign(shift.dawnAmp)}, tau {sign(shift.tauMin)}.{" "}
        {model.patient.simulated
          ? "Applied to the record column only."
          : "Not applied to the CGMacros ridge."}
      </p>
    </div>
  );
}

function TwinHealthPanel({ model, index }: { model: PatientModel; index: number }) {
  const consent = useTwinUi((state) => state.consent[model.patient.id]) ?? {
    ehr: true,
    wearable: true,
  };
  const snapshot = useMemo(
    () =>
      replayHealth({
        knobs: model.params.knobs,
        untilIndex: index,
        readings: model.readings.map((reading) => ({
          glucose: reading?.glucose ?? null,
          gap: !reading || reading.glucose == null || reading.cgmGap || reading.compressionLow,
        })),
        meals: model.meals
          .filter((meal) => meal.logged)
          .map((meal) => ({
            min: meal.min,
            carbs: meal.carbs,
            fiber: meal.fiber,
            protein: meal.protein,
            fat: meal.fat,
            name: meal.name,
          })),
        walks: model.walks
          .filter((walk) => walk.logged)
          .map((walk) => ({ min: walk.min, durationMin: walk.durationMin })),
      }),
    [model, index],
  );
  let present = 0;
  let asked = 0;
  for (let cursor = Math.max(0, index - 287); cursor <= index; cursor += 1) {
    asked += 1;
    const reading = model.readings[cursor];
    if (reading && reading.glucose != null && !reading.cgmGap && !reading.compressionLow)
      present += 1;
  }
  const complete = asked ? Math.round((present / asked) * 1000) / 10 : 0;
  const coverage =
    snapshot.coverage24h == null ? "—" : `${Math.round(snapshot.coverage24h * 1000) / 10}%`;
  const delta = snapshot.knobDelta;
  const signed = (value: number) => `${value >= 0 ? "+" : ""}${Math.round(value * 10) / 10}`;
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="font-display text-xl">Twin health</h2>
      <p className="mt-1 text-sm text-pretty text-muted">
        Online tracker from the start of this stream to the minute on screen. It does not replace
        the fitted curve or the published error table.{" "}
        {model.patient.simulated ? "Simulated." : "CGMacros."} Research prototype — not a medical
        device, not medical advice.
      </p>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <Fact label="Model version" value={MODEL_VERSION} />
        <Fact
          label="Last night step"
          value={
            snapshot.lastCalibrationIndex == null
              ? "None yet"
              : whenLabel(model, snapshot.lastCalibrationIndex)
          }
        />
        <Fact label="24-h band coverage" value={`${coverage} · target 80%`} />
        <Fact label="Drift" value={snapshot.drift} />
        <Fact label="Data completeness, last 24 h" value={`${complete}%`} />
        <Fact
          label="Consent"
          value={`Record ${consent.ehr ? "shared" : "withdrawn"} · wearables ${consent.wearable ? "shared" : "withdrawn"}`}
        />
      </dl>
      <p className="mt-3 text-xs text-muted tabular-nums">
        Knob change since the start: carb {signed(delta.carbSensitivity)}, activity{" "}
        {signed(delta.activityEffect)}, fasting {signed(delta.fastingBaseline)}, dawn{" "}
        {signed(delta.dawnAmp)}, tau {signed(delta.tauMin)}. Bias {signed(snapshot.bias)} mg/dL.{" "}
        {snapshot.bounds}.
      </p>
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

function Param({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="font-display text-xl tabular-nums">{value}</p>
      <p className="text-xs text-muted">{detail}</p>
    </div>
  );
}

export function AlertsView({ model }: { model: PatientModel }) {
  const wardIndex = useTwinUi((state) => state.wardIndex);
  const index = availableIndex(model, wardIndex);
  const stale = isStreamStale(model, wardIndex);
  const acks = useTwinUi((state) => state.acks);
  const acknowledge = useTwinUi((state) => state.acknowledge);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const visible = model.alerts
    .filter((alert) => alert.index <= index && index - alert.index <= 288)
    .slice()
    .reverse();

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-3xl">Alerts · {model.patient.name}</h1>
        <p className="mt-1 text-sm text-muted">
          Spike: max glucose in 120 min above 180, or a 50 mg/dL rise, while currently at or under
          180. Low: min in 60 min under 70, while currently at or over 70. Compression lows are
          ignored.
        </p>
      </div>
      {stale ? (
        <p className="rounded-xl bg-amber-soft px-4 py-3 text-sm font-medium">
          New alerts are blocked while the stream is stale.
        </p>
      ) : null}
      {visible.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">
          No alerts in the last 24 hours of this stream.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((alert) => {
            const outcome = revealOutcome(alert, index);
            const ack = acks[alert.id];
            return (
              <li key={alert.id} className="rounded-2xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs font-semibold",
                      alert.kind === "low"
                        ? "bg-indigo-soft text-indigo"
                        : "bg-amber-soft text-amber",
                    )}
                  >
                    {alert.kind === "low" ? "Low" : "Spike"} · {alert.severity}
                  </span>
                  <span className="text-sm tabular-nums">{whenLabel(model, alert.index)}</span>
                  <span className="text-sm text-muted">
                    Probability {Math.round(alert.probability * 100)}%
                  </span>
                </div>
                <ul className="mt-2 flex flex-col gap-1 text-sm">
                  {alert.reasons.map((reason) => (
                    <li key={reason.group}>
                      <span className="font-semibold">{reason.group}. </span>
                      {reason.text}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-sm">
                  Outcome:{" "}
                  {outcome === "pending"
                    ? "Still inside the watch window"
                    : outcome === "happened"
                      ? `Happened${alert.leadMin != null ? `, lead ${alert.leadMin} min` : ""}`
                      : "Did not happen"}
                  {ack ? ` · Marked ${ack.status === "ack" ? "acknowledged" : "false alarm"}` : ""}
                </p>
                <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                  <button
                    type="button"
                    className="h-11 rounded-full bg-ink px-4 text-sm font-semibold text-paper"
                    onClick={() =>
                      acknowledge(alert.id, "ack", drafts[alert.id] ?? ack?.note ?? "")
                    }
                  >
                    Acknowledge
                  </button>
                  <button
                    type="button"
                    className="h-11 rounded-full border border-line px-4 text-sm font-semibold"
                    onClick={() =>
                      acknowledge(alert.id, "false", drafts[alert.id] ?? ack?.note ?? "")
                    }
                  >
                    Mark false alarm
                  </button>
                  <input
                    value={drafts[alert.id] ?? ack?.note ?? ""}
                    onChange={(event) =>
                      setDrafts((prev) => ({ ...prev, [alert.id]: event.target.value }))
                    }
                    placeholder="Note"
                    className="h-11 min-w-0 flex-1 rounded-full border border-line bg-paper px-4 text-sm"
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function ProtocolPanel({
  model,
  chosen,
  onChoose,
}: {
  model: PatientModel;
  chosen: string | undefined;
  onChoose: (id: PlanId) => void;
}) {
  const rows = useMemo(() => rankPlans(model), [model]);
  const slot = useMemo(() => riskiestSlot(model), [model]);
  const locale = useTwinUi((state) => state.locale);
  const textOf = (row: (typeof rows)[number]) => planText(row, slot, locale);
  const chosenRow = rows.find((row) => row.id === chosen);
  const deltas = planDeltas(rows);
  const protein = rows.find((row) => row.id === "protein-swap");
  const millet = rows.find((row) => row.id === "jowar-roti");
  const direction =
    protein && millet
      ? protein.above180Min < millet.above180Min
        ? `The dal and paneer plate spends ${millet.above180Min - protein.above180Min} fewer minutes above 180 than the jowar plate. The twin only sees that as fewer carbohydrate grams. Jowar keeps the carbohydrate grams and changes fiber. That matches the direction in Anjana et al., Nature Medicine 2025, and it is not a reproduction of their study.`
        : `On this twin the jowar plate is not worse than dal and paneer (${millet.above180Min} vs ${protein.above180Min} minutes above 180). The twin has no protein term beyond carbohydrate grams and fiber. Cited direction: Anjana et al., Nature Medicine 2025.`
      : "";
  return (
    <section className="rounded-2xl border border-line bg-surface p-4">
      <h2 className="font-display text-xl">{t("whatif.header", locale)}</h2>
      <p className="mt-1 text-sm text-pretty text-muted">
        {t("whatif.note", locale)}
        {chosen
          ? ` ${t("whatif.selectedPrefix", locale)} ${chosenRow ? textOf(chosenRow).label : chosen}.`
          : ""}
      </p>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[32rem] text-left text-sm">
          <thead className="text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="py-2 pr-3 font-semibold">{t("whatif.colPlan", locale)}</th>
              <th className="py-2 pr-3 font-semibold">{t("whatif.colTir", locale)}</th>
              <th className="py-2 pr-3 font-semibold">{t("whatif.colAbove", locale)}</th>
              <th className="py-2 pr-3 font-semibold">{t("whatif.colBelow", locale)}</th>
              <th className="py-2 font-semibold">{t("whatif.colMean", locale)}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const delta = deltas.find((item) => item.id === row.id)!;
              return (
                <tr key={row.id} className="border-t border-line align-top">
                  <td className="py-2 pr-3">
                    <p className="font-semibold">{textOf(row).label}</p>
                    <p className="text-xs text-muted">{textOf(row).note}</p>
                    {row.id !== "as-logged" ? (
                      <button
                        type="button"
                        className="mt-1 h-9 rounded-full bg-ink px-3 text-xs font-semibold text-paper"
                        onClick={() => onChoose(row.id)}
                      >
                        {t(chosen === row.id ? "whatif.selected" : "whatif.select", locale)}
                      </button>
                    ) : null}
                    {row.why ? (
                      <p className="mt-1 text-xs italic text-teal">
                        <span className="font-semibold not-italic">{t("whatif.why", locale)}</span>
                        {locale === "hi" ? row.whyHi : row.why}
                      </p>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">
                    {row.tirPct}%
                    {row.id === "as-logged" ? "" : ` (${delta.tir > 0 ? "+" : ""}${delta.tir})`}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">
                    {row.above180Min}
                    {row.id === "as-logged" ? "" : ` (${delta.above > 0 ? "+" : ""}${delta.above})`}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">
                    {row.below70Min}
                    {row.id === "as-logged" ? "" : ` (${delta.below > 0 ? "+" : ""}${delta.below})`}
                  </td>
                  <td className="py-2 tabular-nums">
                    {row.meanGlucose}
                    {row.id === "as-logged" ? "" : ` (${delta.mean > 0 ? "+" : ""}${delta.mean})`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">{direction}</p>
    </section>
  );
}

export function WhatIfView({ model }: { model: PatientModel }) {
  const ward = useWard();
  const unit = useTwinUi((state) => state.unit);
  const wardIndex = useTwinUi((state) => state.wardIndex);
  const index = availableIndex(model, wardIndex);
  const stale = isStreamStale(model, wardIndex);
  const night = model.nights[Math.floor((index * STEP_MIN) / 1440)];
  const chosen = useTwinUi((state) => state.plans[model.patient.id]);
  const choosePlan = useTwinUi((state) => state.choosePlan);
  const [items, setItems] = useState<PlateItem[]>([]);
  const [query, setQuery] = useState("");
  const [walkMin, setWalkMin] = useState(0);
  const [walkIn, setWalkIn] = useState(20);
  const [mealIn, setMealIn] = useState(15);
  const [sleep, setSleep] = useState<number | null>(null);
  const [horizon, setHorizon] = useState<120 | 240>(120);
  const [planned, setPlanned] = useState<{
    inMin: number;
    carbs: number;
    fiber: number;
    protein: number;
    fat: number;
    name: string;
  } | null>(null);

  const nowMin = index * STEP_MIN;
  const usual = usualMeal(model, nowMin);
  const summed = sumMacros(items);
  const mealEdit = planned
    ? {
        inMin: planned.inMin,
        carbs: planned.carbs,
        fiber: planned.fiber,
        protein: planned.protein,
        fat: planned.fat,
        name: planned.name,
      }
    : items.length
      ? { inMin: mealIn, items }
      : null;
  const baseline = stale ? null : forecastAt(model, index, { horizonMin: horizon });
  const edited = stale
    ? null
    : forecastAt(model, index, {
        meal: mealEdit,
        walk: walkMin > 0 ? { inMin: walkIn, durationMin: walkMin } : null,
        sleepHours: model.patient.simulated ? sleep : null,
        horizonMin: horizon,
      });
  const over = (planned?.carbs ?? summed.macros.carbs) > ward.trainingMaxCarbs;
  const foods = FOODS.filter((food) =>
    food.dish.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const basePeak = baseline ? peakOf(baseline) : null;
  const editPeak = edited ? peakOf(edited) : null;
  const baseHigh = baseline ? minutesAbove(baseline, 180) : null;
  const editHigh = edited ? minutesAbove(edited, 180) : null;

  const advice =
    basePeak == null || editPeak == null || baseHigh == null || editHigh == null
      ? "Forecast paused."
      : `At ${whenLabel(model, index)}, the planned change moves the forecast peak by ${Math.round(editPeak - basePeak)} mg/dL (${Math.round(basePeak)} to ${Math.round(editPeak)}). Minutes above 180 change from ${baseHigh} to ${editHigh}. Simulation, not advice.`;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-3xl">What-if · {model.patient.name}</h1>
        <p className="mt-1 text-sm text-muted">
          Add a verified Indian food portion, a walk, or last night’s sleep. Protein and fat are
          recorded from IFCT but do not move this curve. The horizon is 2 or 4 hours. Unverified
          dishes stay disabled.
        </p>
      </div>
      <ProtocolPanel
        model={model}
        chosen={chosen}
        onChoose={(id) => choosePlan(model.patient.id, id)}
      />
      {stale ? (
        <p className="rounded-xl bg-amber-soft px-4 py-3 text-sm font-medium">
          Forecast paused — the stream is stale.
        </p>
      ) : null}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <div className="no-print flex flex-col gap-3 rounded-2xl border border-line bg-surface p-4">
          <div className="flex flex-wrap gap-2">
            {([120, 240] as const).map((value) => (
              <button
                key={value}
                type="button"
                className={cn(
                  "h-10 rounded-full px-4 text-sm font-semibold",
                  horizon === value ? "bg-ink text-paper" : "border border-line",
                )}
                onClick={() => setHorizon(value)}
              >
                {value === 120 ? "2 hours" : "4 hours"}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={!usual}
            className="h-11 rounded-full bg-teal-soft px-4 text-left text-sm font-semibold text-teal disabled:opacity-50"
            onClick={() => {
              if (!usual) return;
              const inMin = Math.max(5, Math.round((usual.atMin - nowMin) / 5) * 5);
              setItems([]);
              setPlanned({
                inMin,
                carbs: usual.carbs,
                fiber: usual.fiber,
                protein: usual.protein,
                fat: usual.fat,
                name: usual.name,
              });
            }}
          >
            {usual
              ? `I’m about to eat this · ${usual.name}, ${Math.round(usual.carbs)} g carbs`
              : "No usual meal in the next 90 minutes"}
          </button>
          <div className="flex flex-wrap gap-2">
            {PLATES.map((plate) => (
              <button
                key={plate.id}
                type="button"
                className="rounded-full border border-line px-3 py-2 text-left text-xs font-semibold"
                onClick={() => setItems(plate.items)}
              >
                {plate.name}
              </button>
            ))}
          </div>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search foods"
            className="h-11 rounded-full border border-line bg-paper px-4 text-sm"
          />
          <ul className="max-h-52 overflow-auto">
            {foods.map((food) => (
              <li
                key={food.id}
                className="flex items-center justify-between gap-2 border-t border-line py-2 text-sm"
              >
                <span>
                  {food.dish}
                  <span className="block text-xs text-muted">{food.serving}</span>
                </span>
                {food.per100 ? (
                  <button
                    type="button"
                    className="h-10 rounded-full bg-teal-soft px-3 text-xs font-semibold text-teal"
                    onClick={() => {
                      setPlanned(null);
                      setItems((prev) => [...prev, { foodId: food.id, servings: 1 }]);
                    }}
                  >
                    Add
                  </button>
                ) : (
                  <span className="text-xs font-semibold text-muted">Needs source</span>
                )}
              </li>
            ))}
          </ul>
          {items.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {items.map((item, itemIndex) => {
                const food = FOODS.find((entry) => entry.id === item.foodId);
                return (
                  <li
                    key={`${item.foodId}-${itemIndex}`}
                    className="flex items-center justify-between gap-2 text-sm"
                  >
                    <span className="min-w-0 truncate">{food?.dish}</span>
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        className="size-11 rounded-full border border-line"
                        onClick={() =>
                          setItems((prev) =>
                            prev.flatMap((row, i) =>
                              i !== itemIndex
                                ? [row]
                                : row.servings <= 0.5
                                  ? []
                                  : [{ ...row, servings: row.servings - 0.5 }],
                            ),
                          )
                        }
                      >
                        −
                      </button>
                      <span className="w-8 text-center tabular-nums">{item.servings}</span>
                      <button
                        type="button"
                        className="size-11 rounded-full border border-line"
                        onClick={() =>
                          setItems((prev) =>
                            prev.map((row, i) =>
                              i === itemIndex ? { ...row, servings: row.servings + 0.5 } : row,
                            ),
                          )
                        }
                      >
                        +
                      </button>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <p className="text-sm tabular-nums">
            {planned
              ? `${planned.name} · ${Math.round(planned.carbs)} g carbs · in ${planned.inMin} min`
              : `${Math.round(summed.macros.carbs)} g carbs · ${summed.macros.fiber.toFixed(1)} g fiber · ${summed.macros.protein.toFixed(1)} g protein · ${summed.macros.fat.toFixed(1)} g fat`}
          </p>
          {over ? (
            <p className="rounded-xl bg-amber-soft px-3 py-2 text-xs font-semibold text-amber">
              Above the training max of {ward.trainingMaxCarbs} g carbs. Shown, but outside the
              range the twin was tuned on.
            </p>
          ) : null}
          <label className="text-sm">
            Meal starts in {mealIn} min
            <input
              type="range"
              min={0}
              max={90}
              step={5}
              value={mealIn}
              onChange={(event) => setMealIn(Number(event.target.value))}
              className="mt-1 w-full accent-teal"
            />
          </label>
          <label className="text-sm">
            Walk {walkMin} min
            <input
              type="range"
              min={0}
              max={60}
              step={5}
              value={walkMin}
              onChange={(event) => setWalkMin(Number(event.target.value))}
              className="mt-1 w-full accent-teal"
            />
          </label>
          <label className="text-sm">
            Walk starts in {walkIn} min
            <input
              type="range"
              min={0}
              max={90}
              step={5}
              value={walkIn}
              onChange={(event) => setWalkIn(Number(event.target.value))}
              className="mt-1 w-full accent-teal"
            />
          </label>
          {model.patient.simulated ? (
            <label className="text-sm">
              Last night’s sleep {formatHours(sleep ?? night?.durationH ?? 7)} h
              <span className="ml-2 rounded-full bg-amber-soft px-2 py-0.5 text-xs font-semibold text-amber">
                Simulated
              </span>
              <input
                type="range"
                min={4}
                max={9}
                step={0.5}
                value={sleep ?? night?.durationH ?? 7}
                onChange={(event) => setSleep(Number(event.target.value))}
                className="mt-1 w-full accent-teal"
              />
            </label>
          ) : (
            <p className="text-sm text-muted">
              Sleep is not in this record. The twin keeps a neutral sleep factor.
            </p>
          )}
          <button
            type="button"
            className="h-11 rounded-full border border-line text-sm font-semibold"
            onClick={() => {
              setItems([]);
              setWalkMin(0);
              setSleep(null);
              setPlanned(null);
              setHorizon(120);
            }}
          >
            Reset edits
          </button>
        </div>
        <div id="advice-sheet" className="rounded-2xl border border-line bg-surface p-4">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-2xl">Baseline vs simulation</h2>
              <p className="text-xs font-semibold text-amber">Simulation, not advice</p>
            </div>
            <button
              type="button"
              className="no-print inline-flex h-11 items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-paper"
              onClick={() => window.print()}
            >
              <Printer className="size-4" />
              Save PDF
            </button>
          </div>
          <GlucoseChart
            model={model}
            wardIndex={wardIndex}
            unit={unit}
            horizonMin={horizon}
            comparison={items.length || planned || walkMin > 0 || sleep != null ? edited : null}
          />
          <p className="mt-2 text-xs text-muted">
            The wash is the conformal 10–90% band around the logged forecast, not the what-if curve.
            {horizon === 240 ? " Past 2 hours that band is the 2-hour band, held flat." : ""}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <Fact
              label="Peak now"
              value={
                basePeak == null
                  ? "—"
                  : `${formatGlucose(basePeak, unit)} ${glucoseUnitLabel(unit)}`
              }
            />
            <Fact
              label="Peak edited"
              value={
                editPeak == null
                  ? "—"
                  : `${formatGlucose(editPeak, unit)} ${glucoseUnitLabel(unit)}`
              }
            />
            <Fact
              label="Δ peak"
              value={
                basePeak == null || editPeak == null
                  ? "—"
                  : `${Math.round(editPeak - basePeak)} mg/dL`
              }
            />
            <Fact
              label="Minutes > 180"
              value={baseHigh == null || editHigh == null ? "—" : `${baseHigh} → ${editHigh}`}
            />
          </div>
          <p className="mt-3 text-sm text-pretty">{advice}</p>
          <p className="mt-2 text-xs text-muted">
            Macros from IFCT 2017 (Longvah et al., NIN–ICMR), scaled to the serving. GI is not in
            IFCT and is left blank. Research prototype — not a medical device, not medical advice.
          </p>
        </div>
      </div>
    </div>
  );
}

function signedGlucose(mgdl: number, unit: GlucoseUnit): string {
  const text = formatGlucose(Math.abs(mgdl), unit);
  if (mgdl >= 0.5) return `+${text}`;
  if (mgdl <= -0.5) return `−${text}`;
  return text;
}

function barClass(kind: TraceContributor["kind"]): string {
  if (kind === "meal" || kind === "unlogged") return "bg-amber";
  if (kind === "walk") return "bg-indigo";
  if (kind === "residual") return "bg-ink";
  return "bg-teal";
}

function SplitRows({
  items,
  scale,
  unit,
}: {
  items: TraceContributor[];
  scale: number;
  unit: GlucoseUnit;
}) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.id}>
          <div className="flex items-baseline justify-between gap-3">
            <p className="min-w-0">
              <span className="font-semibold">{item.label}</span>
              <span className="mt-0.5 block text-xs text-muted">{item.detail}</span>
            </p>
            <p className="shrink-0 font-display text-xl tabular-nums">
              {signedGlucose(item.mgdl, unit)}
              <span className="ml-1 font-sans text-xs font-medium text-muted">
                {glucoseUnitLabel(unit)}
              </span>
            </p>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-paper">
            <div
              className={cn("h-2 rounded-full", barClass(item.kind))}
              style={{
                width: `${Math.max(4, Math.min(100, (Math.abs(item.mgdl) / scale) * 100))}%`,
              }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function pointAt(curve: CurvePoint[] | null, minutes: number): number | null {
  return curve?.find((point) => point.minutesAhead === minutes)?.p50 ?? null;
}

export function SplitView({ model }: { model: PatientModel }) {
  const unit = useTwinUi((state) => state.unit);
  const wardIndex = useTwinUi((state) => state.wardIndex);
  const index = availableIndex(model, wardIndex);
  const stale = isStreamStale(model, wardIndex);
  const trace = traceNow(model, index);
  const [reveal, setReveal] = useState(false);
  const hasHidden = (trace?.unlogged.length ?? 0) > 0;
  const canForecast = !stale && trace?.blocked == null;
  const informed =
    canForecast && reveal && hasHidden ? forecastAt(model, index, { includeUnlogged: true }) : null;
  const logged = canForecast ? forecastAt(model, index) : null;
  const loggedLater = pointAt(logged, 60);
  const informedLater = pointAt(informed, 60);
  const scale = Math.max(
    1,
    ...(trace?.contributors.map((item) => Math.abs(item.mgdl)) ?? []),
    ...(trace?.unlogged.map((item) => Math.abs(item.mgdl)) ?? []),
  );

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-3xl">Glucose split · {model.patient.name}</h1>
        <p className="mt-1 max-w-2xl text-sm text-pretty text-muted">
          The current reading is split into the circadian baseline, each logged meal or walk that is
          still active, and whatever is left. Unlogged snacks sit outside that sum. Protein and fat
          are stored but do not move the curve.
        </p>
      </div>
      {stale ? (
        <p className="rounded-xl bg-amber-soft px-4 py-3 text-sm font-medium">
          The stream is behind the ward clock. This split uses the last sample. The forward curve
          stays off.
        </p>
      ) : null}
      {trace?.blocked === "gap" ? (
        <p className="rounded-xl bg-amber-soft px-4 py-3 text-sm font-medium">
          This minute is a CGM gap. There is no glucose to split, and the forecast stays off.
        </p>
      ) : null}
      {trace?.blocked === "compression" ? (
        <p className="rounded-xl bg-indigo-soft px-4 py-3 text-sm font-medium text-indigo">
          This minute is a compression low. It is kept out of the twin.
        </p>
      ) : null}
      {trace?.blocked === "missing" ? (
        <p className="rounded-xl bg-paper px-4 py-3 text-sm font-medium">
          No glucose at this minute.
        </p>
      ) : null}
      {trace && trace.blocked == null && trace.glucose != null ? (
        <section className="rounded-2xl border border-line bg-surface p-4">
          <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="text-xs font-semibold tracking-wide text-muted uppercase">
                Pieces in the twin
              </p>
              <p className="font-display text-4xl tabular-nums">
                {formatGlucose(trace.glucose, unit)}
                <span className="ml-2 text-base font-sans text-muted">
                  {glucoseUnitLabel(unit)}
                </span>
              </p>
            </div>
            <p className="max-w-xs text-xs text-muted">
              Dawn right now {Math.round(trace.dawnMgdl)} mg/dL.{" "}
              {model.nights[0]?.simulated === false
                ? "Sleep is not in this record, so the carb factor stays neutral."
                : `Last night ${formatHours(trace.sleepHours)} h${trace.sleepScale > 1 ? `, carb pieces ×${trace.sleepScale.toFixed(2)}` : ""}. Simulated sleep.`}
            </p>
          </div>
          <SplitRows items={trace.contributors} scale={scale} unit={unit} />
          <p className="mt-3 text-xs text-muted">
            The pieces above add back to the current glucose. Residual is the closer.
          </p>
        </section>
      ) : null}
      {trace ? (
        <section className="rounded-2xl border border-line bg-surface p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-2xl">Not in the twin</h2>
              <p className="mt-1 text-sm text-muted">
                Snacks in the generator that were never logged. They already sit inside the
                residual.
              </p>
            </div>
            {hasHidden && canForecast ? (
              <button
                type="button"
                className={cn(
                  "h-11 rounded-full px-4 text-sm font-semibold",
                  reveal ? "bg-indigo text-paper" : "border border-line bg-surface text-ink",
                )}
                onClick={() => setReveal((value) => !value)}
              >
                {reveal ? "Hide if-logged curve" : "Show if logged"}
              </button>
            ) : null}
          </div>
          {trace.unlogged.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              No unlogged snack is still affecting this minute.
            </p>
          ) : (
            <div className="mt-4">
              <SplitRows items={trace.unlogged} scale={scale} unit={unit} />
            </div>
          )}
          {informed && loggedLater != null && informedLater != null ? (
            <p className="mt-3 text-sm text-pretty">
              Same glucose now. In 60 minutes the logged-only forecast is{" "}
              {formatGlucose(loggedLater, unit)} {glucoseUnitLabel(unit)}, and the curve that knows
              about the snack is {formatGlucose(informedLater, unit)} {glucoseUnitLabel(unit)}.
              Simulation, not advice.
            </p>
          ) : null}
        </section>
      ) : null}
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-display text-2xl">Logged forecast vs snack on the record</h2>
        <p className="text-xs text-muted">
          Dashed teal ignores the hidden snack. Indigo appears only after you replay it as logged.
        </p>
        <GlucoseChart
          model={model}
          wardIndex={wardIndex}
          unit={unit}
          comparison={informed}
          comparisonName="If logged"
        />
      </section>
      {trace ? (
        <section className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-line bg-surface p-4">
            <h2 className="font-display text-xl">Sensor marks</h2>
            <p className="mt-2 text-sm">{markLine(trace.recent, "In the last 6 hours")}</p>
            <p className="mt-1 text-sm">{markLine(trace.today, "So far today")}</p>
          </div>
          <div className="rounded-2xl border border-line bg-surface p-4">
            <h2 className="font-display text-xl">Labs on file</h2>
            <p className="mt-1 text-xs text-muted">Not inputs to this curve.</p>
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
              <Fact
                label="Triglycerides"
                value={
                  model.patient.triglycerides == null ? "—" : `${model.patient.triglycerides} mg/dL`
                }
              />
              <Fact
                label="HDL"
                value={model.patient.hdl == null ? "—" : `${model.patient.hdl} mg/dL`}
              />
              <Fact
                label="LDL"
                value={model.patient.ldl == null ? "—" : `${model.patient.ldl} mg/dL`}
              />
              <Fact
                label="Fasting insulin"
                value={
                  model.patient.fastingInsulin == null
                    ? "—"
                    : `${model.patient.fastingInsulin} µU/mL`
                }
              />
            </dl>
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function NightView({ model }: { model: PatientModel }) {
  const unit = useTwinUi((state) => state.unit);
  const wardIndex = useTwinUi((state) => state.wardIndex);
  const index = availableIndex(model, wardIndex);
  const review = nightReview(model, index);
  const latest = review.rows[0];
  const shortNights = review.rows.filter((row) => row.short).length;
  const lowNights = review.rows.filter((row) => row.below70Min > 0).length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="font-display text-3xl">Overnight · {model.patient.name}</h1>
        <p className="mt-1 max-w-2xl text-sm text-pretty text-muted">
          {model.patient.simulated
            ? "Midnight to 08:00, for mornings that have already reached the clock. Rise is 08:00 minus 04:00. The shaded band is the middle half of those mornings. Short sleep is the simulated night on that calendar day."
            : "Midnight to 08:00 on the shifted CGMacros clock. Rise is 08:00 minus 04:00. CGMacros has no sleep stream, so sleep hours are not shown as measured. The twin uses a neutral sleep factor."}
        </p>
      </div>
      {review.rows.length === 0 ? (
        <p className="rounded-2xl border border-line bg-surface p-4 text-sm text-muted">
          No overnight window has finished yet.
        </p>
      ) : (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              label="Latest rise"
              value={latest?.rise == null ? "—" : signedGlucose(latest.rise, unit)}
              detail={latest?.partial ? "Morning still open" : "08:00 minus 04:00"}
            />
            <Stat
              label="Median rise"
              value={review.medianRise == null ? "—" : signedGlucose(review.medianRise, unit)}
              detail={`${review.rows.filter((row) => row.rise != null).length} finished mornings`}
            />
            <Stat label="Nights under 70" value={String(lowNights)} detail="Any minute below 70" />
            <Stat
              label="Short sleep"
              value={model.patient.simulated ? String(shortNights) : "—"}
              detail={model.patient.simulated ? "Simulated, under 6 h" : "Not in CGMacros"}
            />
          </section>
          <section className="rounded-2xl border border-line bg-surface p-4">
            <h2 className="font-display text-2xl">Midnight to morning</h2>
            <p className="text-xs text-muted">
              Ink is the median. Indigo is the latest morning in this window. The forecast dawn bump
              is {Math.round(model.params.knobs.dawnAmp)} mg/dL, a group prior, not fitted from
              these nights.
            </p>
            <NightChart bins={review.bins} unit={unit} />
          </section>
          <ul className="flex flex-col gap-3">
            {review.rows.map((row) => (
              <li key={row.dayIndex} className="rounded-2xl border border-line bg-surface p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-display text-xl">
                    {dayLabel(model, row.dayIndex * STEPS_PER_DAY)}
                  </h2>
                  {row.partial ? (
                    <span className="rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted">
                      Still open
                    </span>
                  ) : null}
                  {row.short ? (
                    <span className="rounded-full bg-amber-soft px-2 py-0.5 text-xs font-semibold text-amber">
                      Short sleep
                    </span>
                  ) : null}
                  {row.below70Min > 0 ? (
                    <span className="rounded-full bg-indigo-soft px-2 py-0.5 text-xs font-semibold text-indigo">
                      {row.below70Min} min under 70
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-sm tabular-nums">
                  {row.rise == null
                    ? "Rise not available yet"
                    : `Rise ${signedGlucose(row.rise, unit)} ${glucoseUnitLabel(unit)}`}
                  {row.at4 != null ? ` · 04:00 ${formatGlucose(row.at4, unit)}` : ""}
                  {row.at8 != null ? ` · 08:00 ${formatGlucose(row.at8, unit)}` : ""}
                  {row.nadir != null ? ` · nadir ${formatGlucose(row.nadir, unit)}` : ""}
                </p>
                <p className="mt-1 text-xs text-muted">
                  {model.nights[0]?.simulated === false
                    ? "Sleep not recorded"
                    : `Sleep ${formatHours(row.sleepHours)} h`}
                  {model.nights[row.dayIndex]?.stages
                    ? ` · awake ${model.nights[row.dayIndex]!.stages!.awakeMin} · light ${model.nights[row.dayIndex]!.stages!.lightMin} · deep ${model.nights[row.dayIndex]!.stages!.deepMin} · REM ${model.nights[row.dayIndex]!.stages!.remMin} min`
                    : ""}
                  {model.nights[row.dayIndex]?.steps != null
                    ? ` · ${model.nights[row.dayIndex]!.steps} steps`
                    : ""}
                  {row.above180Min > 0 ? ` · ${row.above180Min} min above 180` : ""}
                  {row.gapMin > 0 ? ` · ${row.gapMin} min gap` : ""}
                  {row.compressionMin > 0 ? ` · ${row.compressionMin} min compression` : ""}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="text-xs text-muted">
        Research prototype — not a medical device, not medical advice. No dosing and no diagnosis.
      </p>
    </div>
  );
}

function markLine(
  marks: { gapMin: number; compressionMin: number; offWristMin: number; sharpJumps: number },
  scope: string,
): string {
  const bits: string[] = [];
  if (marks.gapMin) bits.push(`${marks.gapMin} min of gap`);
  if (marks.compressionMin) bits.push(`${marks.compressionMin} min of compression`);
  if (marks.offWristMin) bits.push(`${marks.offWristMin} min off the wrist`);
  if (marks.sharpJumps)
    bits.push(`${marks.sharpJumps} sharp ${marks.sharpJumps === 1 ? "jump" : "jumps"}`);
  if (!bits.length) return `${scope}: none.`;
  return `${scope}: ${bits.join(", ")}.`;
}

export function ReportView({ model }: { model: PatientModel }) {
  const unit = useTwinUi((state) => state.unit);
  const wardIndex = useTwinUi((state) => state.wardIndex);
  const index = availableIndex(model, wardIndex);
  const current = weekStats(model, index, 7);
  const previousEnd = Math.max(0, index - 7 * 288);
  const previous = weekStats(model, previousEnd, 7);
  const bins = agp(model, index, 7);
  const night = model.nights[Math.floor((index * STEP_MIN) / 1440)];
  const note = clinicalNote({
    mean: current.mean,
    gmi: current.gmi,
    tir: current.tir,
    tar: current.tar,
    tbr: current.tbr,
    cv: current.cv,
    tirDelta: current.tir - previous.tir,
    fasting: model.params.fastingBaseline,
    carbPer10: model.params.carbSensitivity,
    days: 7,
  });

  return (
    <div id="weekly-sheet" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl">Week · {model.patient.name}</h1>
          <p className="mt-1 text-sm text-muted">
            Seven days ending at the latest sample. Compared with the seven days before that.
          </p>
        </div>
        <button
          type="button"
          className="no-print inline-flex h-11 items-center gap-2 rounded-full bg-ink px-4 text-sm font-semibold text-paper"
          onClick={() => window.print()}
        >
          <Printer className="size-4" />
          Save PDF
        </button>
      </div>
      <section className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Time in range"
          value={`${Math.round(current.tir)}%`}
          detail={`70–180 · ${signed(current.tir - previous.tir)} pts`}
        />
        <Stat label="Above range" value={`${Math.round(current.tar)}%`} detail="> 180" />
        <Stat label="Below range" value={`${Math.round(current.tbr)}%`} detail="< 70" />
        <Stat
          label="GMI"
          value={current.gmi.toFixed(1)}
          detail={`mean ${Math.round(current.mean)} mg/dL`}
        />
        <Stat label="CV" value={`${Math.round(current.cv)}%`} detail="SD / mean" />
        <Stat
          label="Mean"
          value={formatGlucose(current.mean, unit)}
          detail={glucoseUnitLabel(unit)}
        />
      </section>
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-display text-2xl">By time of day</h2>
        <p className="text-xs text-muted">
          Median, darker 25–75%, lighter 5–95%. Lines mark 70 and 180 mg/dL.
        </p>
        <AgpChart bins={bins} unit={unit} />
      </section>
      <section className="rounded-2xl border border-line bg-surface p-4">
        <h2 className="font-display text-2xl">Clinical note</h2>
        <p className="mt-2 text-sm text-pretty">{note.text}</p>
        <p className="mt-2 text-xs text-muted">
          Template only, checked so every number appears in the computed inputs. Source:{" "}
          {note.source}.{" "}
          {model.patient.simulated
            ? `Last night’s sleep ${night ? formatHours(night.durationH) : "—"} h, efficiency ${night ? Math.round(night.efficiency * 100) : "—"}%, RMSSD ${night?.rmssd ?? "—"} ms — simulated.`
            : "Sleep was not recorded in CGMacros."}
        </p>
      </section>
      <p className="text-xs text-muted">
        Research prototype — not a medical device, not medical advice. No dosing and no diagnosis.
      </p>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="font-display text-2xl tabular-nums">{value}</p>
      <p className="text-xs text-muted">{detail}</p>
    </div>
  );
}

function signed(value: number): string {
  const rounded = Math.round(value);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}
