import { Printer } from "lucide-react";
import { useEffect, useMemo } from "react";
import {
  availableIndex,
  clockMs,
  groupLabel,
  revealOutcome,
  STEPS_PER_DAY,
  weekStats,
  type PatientModel,
} from "@/lib/glucotwin/cohort";
import { formatGlucose, formatWhenIn, glucoseUnitLabel } from "@/lib/glucotwin/format";
import { LOCALES, planText, t, type Locale } from "@/lib/glucotwin/i18n";
import { planDeltas, rankPlans, riskiestSlot, type PlanScore } from "@/lib/glucotwin/protocol";
import { useTwinUi } from "@/lib/glucotwin/store";

/** Set on <html> while the pre-visit sheet prints; styles.css then hides the app and shows the sheet. */
const PRINT_CLASS = "print-summary";

export function PrintSummaryButton() {
  return (
    <button
      type="button"
      className="inline-flex h-11 items-center gap-2 rounded-full border border-line bg-surface px-4 text-sm font-semibold text-ink"
      onClick={() => {
        document.documentElement.classList.add(PRINT_CLASS);
        window.print();
      }}
    >
      <Printer className="size-4" />
      Clinical summary
    </button>
  );
}

/** EN / हिन्दी switch next to the print button. It sets the language of the What-if plan table and the printed summary. */
export function LanguageToggle({
  value,
  onChange,
}: {
  value: Locale;
  onChange: (next: Locale) => void;
}) {
  return (
    <div
      role="group"
      aria-label={t("language.label", value)}
      title={t("language.label", value)}
      className="no-print inline-flex h-11 overflow-hidden rounded-full border border-line bg-surface text-sm font-semibold text-ink"
    >
      {LOCALES.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-pressed={value === item.id}
          onClick={() => onChange(item.id)}
          className={
            value === item.id
              ? "bg-ink px-3 text-paper"
              : "px-3 text-ink hover:bg-paper"
          }
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function zoneOf(model: PatientModel): string {
  return model.patient.simulated ? "Asia/Kolkata" : "UTC";
}

function when(model: PatientModel, index: number): string {
  return `${formatWhenIn(clockMs(model, index), zoneOf(model))} ${model.patient.simulated ? "IST" : "(shifted)"}`;
}

function signed(value: number, digits = 0): string {
  const text = value.toFixed(digits);
  return value > 0 ? `+${text}` : text;
}

function rankedPlans(model: PatientModel): PlanScore[] | null {
  try {
    const rows = rankPlans(model);
    return rows.length > 1 ? rows : null;
  } catch {
    return null;
  }
}

/**
 * One-page pre-visit sheet for the patient's chart. Screen: hidden.
 * Print: the only thing on the page when started from PrintSummaryButton.
 * Every number comes from the same twin state the dashboard shows.
 *
 * `locale` prints the headings, plan and footer in English or Hindi; the data tables stay in English.
 */
export function ClinicalSummary({
  model,
  locale = "en",
}: {
  model: PatientModel;
  locale?: Locale;
}) {
  const unit = useTwinUi((state) => state.unit);
  const wardIndex = useTwinUi((state) => state.wardIndex);
  const chosen = useTwinUi((state) => state.plans[model.patient.id]);
  const consent = useTwinUi((state) => state.consent[model.patient.id]) ?? {
    ehr: true,
    wearable: true,
  };
  const acks = useTwinUi((state) => state.acks);
  const activeLocale: Locale = locale;
  const index = availableIndex(model, wardIndex);
  const week = weekStats(model, index, 7);
  const before = weekStats(model, Math.max(0, index - 7 * STEPS_PER_DAY), 7);
  const plans = useMemo(() => rankedPlans(model), [model]);
  const picked = plans ? (plans.find((row) => row.id === chosen) ?? plans[1]!) : null;
  const delta = plans && picked ? planDeltas(plans).find((row) => row.id === picked.id) : null;
  const baseline = plans?.find((row) => row.id === "as-logged") ?? null;
  const slot = useMemo(() => (plans ? riskiestSlot(model) : null), [model, plans]);
  const pickedText = picked && slot ? planText(picked, slot, activeLocale) : null;
  const urgent = model.alerts
    .filter(
      (alert) =>
        alert.severity === "urgent" &&
        alert.index <= index &&
        alert.index > index - 7 * STEPS_PER_DAY,
    )
    .slice(-5)
    .reverse();
  // The shell passes the consented twin: with the record withdrawn these are the group-prior
  // knobs plus the personal CGM fit, and the band is already widened.
  const knobs = model.params.knobs;
  const band60 = model.bands[60];

  useEffect(() => {
    const clear = () => document.documentElement.classList.remove(PRINT_CLASS);
    window.addEventListener("afterprint", clear);
    return () => window.removeEventListener("afterprint", clear);
  }, []);

  return (
    <article className="clinical-summary" aria-label="Pre-visit clinical summary">
      <header className="cs-head">
        <div>
          <p className="cs-kicker">{t("summary.kicker", activeLocale)}</p>
          <h1>{model.patient.name}</h1>
          <p>
            {model.patient.id} · {model.patient.age} {t("summary.years", activeLocale)} ·{" "}
            {model.patient.sex === "F" ? t("summary.female", activeLocale) : t("summary.male", activeLocale)} ·{" "}
            {groupLabel(model.patient.group)} ·{" "}
            {consent.ehr
              ? `BMI ${model.patient.bmi.toFixed(1)} · HbA1c ${model.patient.hba1c.toFixed(1)}%`
              : t("summary.recordWithdrawn", activeLocale)}
          </p>
        </div>
        <div className="cs-meta">
          <p>{t("summary.dataTo", activeLocale).replace("{when}", when(model, index))}</p>
          <p>{model.patient.simulated ? t("summary.simWard", activeLocale) : t("summary.realWard", activeLocale)}</p>
          <p>
            {t("summary.consentRecord", activeLocale)}{" "}
            {t(consent.ehr ? "summary.shared" : "summary.withdrawn", activeLocale)},{" "}
            {t("summary.consentWearables", activeLocale)}{" "}
            {t(consent.wearable ? "summary.shared" : "summary.withdrawn", activeLocale)}
          </p>
        </div>
      </header>

      <section>
        <h2>{t("summary.last7", activeLocale)}</h2>
        <table>
          <thead>
            <tr>
              <th>Time in range 70–180</th>
              <th>Above 180</th>
              <th>Below 70</th>
              <th>Mean</th>
              <th>GMI</th>
              <th>CV</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>
                <strong>{Math.round(week.tir)}%</strong> ({signed(week.tir - before.tir)} pts vs
                prior week)
              </td>
              <td>{Math.round(week.tar)}%</td>
              <td>{Math.round(week.tbr)}%</td>
              <td>
                {formatGlucose(week.mean, unit)} {glucoseUnitLabel(unit)}
              </td>
              <td>{week.gmi.toFixed(1)}%</td>
              <td>{Math.round(week.cv)}%</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>{t("summary.twin", activeLocale)}</h2>
        <table>
          <tbody>
            <tr>
              <th>Carb sensitivity</th>
              <td>{knobs.carbSensitivity.toFixed(1)} mg/dL per 10 g carbohydrate</td>
              <th>Activity effect</th>
              <td>{knobs.activityEffect.toFixed(1)} mg/dL drop per 30 min walk</td>
            </tr>
            <tr>
              <th>Fasting baseline</th>
              <td>{Math.round(knobs.fastingBaseline)} mg/dL</td>
              <th>Dawn rise</th>
              <td>{knobs.dawnAmp.toFixed(1)} mg/dL</td>
            </tr>
            <tr>
              <th>Meal time constant</th>
              <td>{Math.round(knobs.tauMin)} min</td>
              <th>Personal weight</th>
              <td>
                {!consent.ehr
                  ? "Group prior + personal fit (record withdrawn)"
                  : model.params.personalTrust >= 1
                    ? "100% personal fit"
                    : model.params.personalTrust <= 0
                      ? model.params.prior === "record"
                        ? "Record + cluster prior (personal fit not clearly better)"
                        : "Group prior (record-based twin not clearly better)"
                      : `${Math.round(model.params.personalTrust * 100)}% personal fit, rest ${model.params.prior === "record" ? "record + cluster" : "group"} prior`}
              </td>
            </tr>
            <tr>
              <th>60-min forecast error</th>
              <td>
                {model.fit.rmse60} mg/dL (group prior {model.fit.rmse60Pop})
              </td>
              <th>60-min band</th>
              <td>
                {signed(band60.q10)} to {signed(band60.q90)} mg/dL (10th–90th)
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section>
        <h2>{chosen ? t("summary.planSelected", activeLocale) : t("summary.planTop", activeLocale)}</h2>
        {picked && pickedText && delta && baseline ? (
          <>
            <p>
              <strong>{pickedText.label}</strong> — time in range {baseline.tirPct}% → {picked.tirPct}%
              ({signed(delta.tir, 1)} pts), minutes above 180 {baseline.above180Min} →{" "}
              {picked.above180Min} ({signed(delta.above)}), mean {baseline.meanGlucose} →{" "}
              {picked.meanGlucose} mg/dL.
            </p>
            <p className="cs-note">{pickedText.note}</p>
            {picked.why ? (
              <p className="cs-note">
                <strong>{t("summary.whyForPatient", activeLocale)}</strong>
                {activeLocale === "hi" ? picked.whyHi : picked.why}
              </p>
            ) : null}
            <p className="cs-note">
              {t("summary.simulated", activeLocale)} {t("summary.advice", activeLocale)}
            </p>
          </>
        ) : (
          <p className="cs-note">{t("summary.noPlan", activeLocale)}</p>
        )}
      </section>

      <section>
        <h2>{t("summary.urgentHeader", activeLocale)}</h2>
        {urgent.length ? (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Kind</th>
                <th>Risk</th>
                <th>Main reason</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {urgent.map((alert) => {
                const outcome = revealOutcome(alert, index);
                const ack = acks[alert.id];
                return (
                  <tr key={alert.id}>
                    <td>{when(model, alert.index)}</td>
                    <td>{alert.kind === "low" ? "Low" : "Spike"}</td>
                    <td>{Math.round(alert.probability * 100)}%</td>
                    <td>
                      {alert.reasons[0]
                        ? `${alert.reasons[0].group}: ${alert.reasons[0].text}`
                        : "—"}
                    </td>
                    <td>
                      {outcome === "pending"
                        ? "Pending"
                        : outcome === "happened"
                          ? "Happened"
                          : "Did not happen"}
                      {ack
                        ? ` · ${ack.status === "ack" ? "acknowledged" : "marked false alarm"}`
                        : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <p className="cs-note">{t("summary.noUrgent", activeLocale)}</p>
        )}
      </section>

      <footer className="cs-foot">
        {t("summary.foot", activeLocale)}
      </footer>
    </article>
  );
}
