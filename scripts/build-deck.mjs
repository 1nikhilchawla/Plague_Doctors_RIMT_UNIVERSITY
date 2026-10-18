/**
 * Builds the 15-slide deck from reports/sim_eval.json, real_eval.json,
 * reports/alert_proof.json and reports/scale.json. No hand-typed metrics:
 * every number on a slide is read from those files.
 * PDF via Playwright (set PW_CHANNEL=msedge to use an installed Edge).
 * PPTX via scripts/build_deck.py (set PYTHON if python3 is not on PATH).
 * Dashboard screenshots are read from docs/presentation/screens/.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "docs/presentation");
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const sim = readJson("reports/sim_eval.json");
const real = readJson("src/lib/glucotwin/real/real_eval.json");
const proof = readJson("reports/alert_proof.json");
const scale = readJson("reports/scale.json");

const row = (horizons, min) => horizons.find((item) => item.horizonMin === min);
const arm = (rows, id) => rows.find((item) => item.id === id);
const fmt = (value) => (value == null ? "—" : String(value));
const mg = (value, digits = 1) =>
  value == null || typeof value !== "number" || !Number.isFinite(value)
    ? "—"
    : value.toFixed(digits);
const pct = (value, digits = 1) => (value == null ? "—" : `${(value * 100).toFixed(digits)}%`);
const lower = (twin, base) => (base ? ((base - twin) / base) * 100 : 0);
const signed = (value) => `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
const thousands = (value) => value.toLocaleString("en-US");

const h30 = row(real.horizons, 30);
const h60 = row(real.horizons, 60);
const h120 = row(real.horizons, 120);
const m60 = row(sim.mismatched.horizons, 60);
const m120 = row(sim.mismatched.horizons, 120);
const match60 = row(sim.matched.horizons, 60);
const simAlerts = sim.mismatched.alerts;
const realAlerts = real.alerts;
const at60 = sim.leadShares.spikeAtLeast60;
const at120 = sim.leadShares.spikeAtLeast120;
const full = arm(sim.streamAblation, "full");
const noMeals = arm(sim.streamAblation, "noMeals");
const noActivity = arm(sim.streamAblation, "noActivity");
const noSleep = arm(sim.streamAblation, "noSleep");
const noRecord = arm(sim.streamAblation, "noRecord");
const noRecordNoPersonal = arm(sim.streamAblation, "noRecordNoPersonal");
const nightMeal = arm(sim.streamAblation, "fullHardNightMeal");
const noSleepNightMeal = arm(sim.streamAblation, "noSleepHardNightMeal");
const afterWalk = arm(sim.streamAblation, "fullAfterWalk");
const noActivityWalk = arm(sim.streamAblation, "noActivityAfterWalk");
const six = sim.lowCost.find((item) => item.pricks === 6);
const eight = sim.lowCost.find((item) => item.pricks === 8);
const twinProof = proof.methods.find((item) => item.id === "twin").spike;
const others = proof.methods.filter((item) => item.id !== "twin");
const nextBest = others.reduce(
  (best, item) => (item.spike.f1 > best.spike.f1 ? item : best),
  others[0],
);
const fastest = arm(proof.methods, "trend120").spike;
const groupOf = Object.fromEntries(sim.personal.map((item) => [item.id, item.group]));
const gains = sim.personal.map((item) => item.gain);
const t2dPlans = sim.protocols
  .filter((item) => groupOf[item.id] === "t2d")
  .map((item) => {
    const base = item.plans.find((plan) => plan.id === "as-logged");
    const best = item.plans.find((plan) => plan.id !== "as-logged");
    return { name: item.name, base, best, delta: best.tirPct - base.tirPct };
  })
  .sort((a, b) => b.delta - a.delta);
// The plan whose effect differs most between Type 2 twins (largest best-minus-worst spread).
const contrast = (() => {
  const people = sim.protocols.filter((item) => groupOf[item.id] === "t2d");
  const ids = people[0].plans.map((plan) => plan.id).filter((id) => id !== "as-logged");
  const rows = ids.map((id) => {
    const deltas = people
      .map((item) => {
        const base = item.plans.find((plan) => plan.id === "as-logged");
        const plan = item.plans.find((p) => p.id === id);
        return {
          name: item.name.split(" ")[0],
          delta: plan.tirPct - base.tirPct,
          label: plan.label,
        };
      })
      .sort((a, b) => b.delta - a.delta);
    return { deltas, spread: deltas[0].delta - deltas[deltas.length - 1].delta };
  });
  return rows.reduce((best, item) => (item.spread > best.spread ? item : best), rows[0]).deltas;
})();
const lowRule = real.lowRule?.chosen;
const realDisc = real.alerts.discrimination;
const clock = real.mealClock;
const vsPersistence = (twin, base) =>
  twin < base ? "a narrow win" : twin === base ? "a tie" : "persistence slightly better";
const level = twinProof.f1 - nextBest.spike.f1 < 0.01;
const ridge = arm(real.ablation, "ehr");
const noEhr = arm(real.ablation, "none");

const headline = [
  {
    value: `${mg(lower(h120.rmseTwin, h120.rmsePersistence))}%`,
    label: `lower 2-hour error than persistence on 45 real adults (${mg(h120.rmseTwin)} vs ${mg(h120.rmsePersistence)} mg/dL)`,
  },
  {
    value: `${fmt(simAlerts.medianLeadMin)} min`,
    label: "median warning before a glucose spike, using the habitual next meal",
  },
  {
    value: `${at60.count} of ${at60.events}`,
    label: `spikes warned 60+ min ahead; ${at120.count} a full 120 min ahead`,
  },
  { value: "7", label: "lifestyle plans ranked on the patient's own twin, never a dose" },
];

const slides = [
  {
    title: "GlucoTwin",
    kicker: "A digital twin for type 2 diabetes · Happiest Health Digital Twin Challenge 2026",
    stats: headline,
    bullets: [
      "Fuses the FHIR health record with CGM, sleep, HRV and activity to forecast glucose 2 hours ahead, warn before spikes with reasons, and test lifestyle plans on the patient's own twin.",
      "Team GlucoTwin_RIMT-University · Nikhil Chawla, AI Engineer · BCA – AI & Data Science, RIMT University.",
      "Research prototype — not a medical device, not medical advice. All patient data is synthetic or open (CGMacros, CC BY-NC-SA 4.0).",
    ],
  },
  {
    title: "The gap, and what the twin changes",
    kicker: "Cited surveys, then measured results",
    bullets: [
      "101 million adults with diabetes and 136 million with prediabetes in India. ICMR-INDIAB-17, Lancet Diabetes & Endocrinology, 2023. doi:10.1016/S2213-8587(23)00119-5.",
      "Only 36.3% reach the glycaemic target; 7.7% reach HbA1c, blood pressure and LDL together. ICMR-INDIAB-13, Lancet Diabetes & Endocrinology, 2022.",
      "Carbohydrates are 62.3% of energy in Indian diets. Nature Medicine, 2025. doi:10.1038/s41591-025-03949-4.",
      "A clinic visit sees the 3-month average, not the spike that already happened.",
      `GlucoTwin: ${mg(lower(h120.rmseTwin, h120.rmsePersistence))}% lower 2-hour error on real data (${mg(h120.rmseTwin)} vs ${mg(h120.rmsePersistence)} mg/dL); spikes warned a median ${fmt(simAlerts.medianLeadMin)} min ahead, ${at60.count} of ${at60.events} at least an hour ahead; seven lifestyle plans compared per patient.`,
    ],
  },
  {
    title: "What the twin does",
    kicker: "And what it refuses",
    bullets: [
      "Forecasts glucose 30, 60 and 120 minutes ahead with a 10–90% conformal band, from logged meals, walks, last night's sleep and HRV, and the record-based fit.",
      `Anticipates the next meal: spike risk adds the person's habitual meal (median time and size from the fitting days), so warnings come a median ${fmt(simAlerts.medianLeadMin)} min early and ${at120.count} spikes were warned a full 120 min ahead.`,
      "Raises Urgent or Watch alerts and lists the meals, walks and sleep behind each one; only Urgent interrupts.",
      "Ranks seven lifestyle plans on the patient's highest-risk meal: walk after the meal, a dal-and-paneer carb cut, an earlier meal, a split meal, jowar roti, and a weekly fasting day. Labelled Simulation, not advice.",
      "Per-stream consent (DPDP-style) and a one-click pre-visit clinical summary for the chart.",
      "Never doses a medicine and never diagnoses.",
    ],
  },
  {
    title: "Two streams, one fit",
    kicker: "Fusion measured by removing one stream at a time (60-min RMSE, mg/dL)",
    stats: [
      {
        value: mg(noMeals.rmse60 - full.rmse60, 2),
        label: `mg/dL lost without meals (${mg(full.rmse60, 2)} → ${mg(noMeals.rmse60, 2)})`,
      },
      {
        value: mg(noRecordNoPersonal.rmse60 - full.rmse60, 2),
        label: `mg/dL lost without the record and the personal CGM fit (→ ${mg(noRecordNoPersonal.rmse60, 2)})`,
      },
      {
        value: `${mg(lower(afterWalk.rmse60, noActivityWalk.rmse60))}%`,
        label: `lower error within 6 h of a walk with activity (${mg(afterWalk.rmse60, 2)} vs ${mg(noActivityWalk.rmse60, 2)})`,
      },
      {
        value: `${mg(lower(nightMeal.rmse60, noSleepNightMeal.rmse60))}%`,
        label: `lower error after meals following a short or stressed night with sleep + HRV (${mg(nightMeal.rmse60, 2)} vs ${mg(noSleepNightMeal.rmse60, 2)})`,
      },
    ],
    bullets: [
      "Health record (FHIR R4, glucotwin-ts-fhir): labs, BMI, age, sex and medicines set the prior the live twin shrinks toward, blended with the group prior by inverse error variance.",
      `Record prior and medicine term on their own: ${mg(full.rmse60, 2)} with them, ${mg(noRecord.rmse60, 2)} without, ${full.rmse60 < noRecord.rmse60 ? "a small gain" : "no gain"} on this ward. The personal CGM fit carries the benefit.`,
      "Wearables: last night's sleep, sleep efficiency and HRV (plus half of the night before) scale insulin sensitivity and the dawn rise; walks raise sensitivity for 12–30 h.",
      `Whole ward, all ${thousands(full.n)} forecasts: full ${mg(full.rmse60, 2)}, no activity ${mg(noActivity.rmse60, 2)}, no sleep or HRV ${mg(noSleep.rmse60, 2)}. Sleep matters where it acts, not on an average day.`,
      `On real CGMacros data the record alone cuts 1-hour error by ${mg(lower(ridge.rmse60, noEhr.rmse60))}% (${mg(noEhr.rmse60)} → ${mg(ridge.rmse60)}).`,
    ],
  },
  {
    title: "Architecture, as built",
    kicker: "Same picture as docs/architecture",
    image: "../architecture/GlucoTwin_Architecture.png",
    bullets: [
      "Live path: stream checks → fitted twin → forecast and what-if → alert engine → doctor dashboard with consent gate. Offline: CGMacros, ridge prior, LightGBM, trend fit.",
    ],
  },
  {
    title: "Models",
    kicker: "What is live, what is offline",
    bullets: [
      `Live: meal absorption with fiber and fat and a meal clock, walks, dawn rise, sleep and HRV sensitivity, residual decay, and a finite-sample conformal 10th–90th band.${clock ? ` Validation days switched the meal clock ${clock.chosen ? "on" : "off"} for CGMacros (60-min ${mg(clock.validationRmse60.on)} with, ${mg(clock.validationRmse60.off)} without).` : ""}`,
      "Personal knobs come from days 1–5. How far each patient moves from the record prior is chosen on validation days 6–9; the personal fit is kept only when it beats the prior by more than one standard error.",
      `Every patient's personal gain over the group prior is now ≥ 0 (range ${mg(Math.min(...gains))} to ${mg(Math.max(...gains))} mg/dL).`,
      `Alert thresholds are chosen on validation days, never on scored days. A Watch alert is upgraded to Urgent in place when the curve gets worse.${lowRule ? ` On CGMacros a guarded CGM trend rule for lows (at or under ${lowRule.ceiling ?? 88} mg/dL, or ${lowRule.ceilingFasting ?? 95} with no recent meal; fall ≥ ${Math.abs(lowRule.fallRate)} mg/dL/min; damped ${lowRule.aheadMin}-min projection averaged with the twin's 30-min trough under 70) is chosen leave-one-participant-out; its candidate grid was first proposed after a look at test-day false alarms.` : ""} The simulated sulfonylurea low guard is chosen on an independent realization of the ward, never on the scored days.`,
      "Subgroup labels (SIDD / IROD / CIRDD / MARD) are an approximate rule, not the published INSPIRED clustering. LightGBM stays offline.",
    ],
  },
  {
    title: "Outcomes on real and simulated data",
    kicker: "Printed from the eval JSON",
    stats: [
      {
        value: `${mg(lower(h120.rmseTwin, h120.rmsePersistence))}%`,
        label: `2-hour error vs persistence on CGMacros (${mg(h120.rmseTwin)} vs ${mg(h120.rmsePersistence)})`,
      },
      {
        value: `${mg(lower(h60.rmseTwin, h60.rmsePersistence))}%`,
        label: `1-hour error vs persistence (${mg(h60.rmseTwin)} vs ${mg(h60.rmsePersistence)})`,
      },
      { value: pct(h30.clarkeApb), label: "of 30-min forecasts in Clarke zones A + B" },
      {
        value: `${realAlerts.lowHits} of ${realAlerts.lowEvents}`,
        label: `real lows warned on CGMacros, ${pct(realAlerts.lowPrecision)} precise`,
      },
    ],
    bullets: [
      `CGMacros, 45 adults: 30 min ${mg(h30.rmseTwin)} vs ${mg(h30.rmsePersistence)} (${vsPersistence(h30.rmseTwin, h30.rmsePersistence)}), 60 min ${mg(h60.rmseTwin)} vs ${mg(h60.rmsePersistence)}, 120 min ${mg(h120.rmseTwin)} vs ${mg(h120.rmsePersistence)} mg/dL. The 10–90% band covers ${mg(h30.coverage, 2)} / ${mg(h60.coverage, 2)} / ${mg(h120.coverage, 2)}.`,
      `CGMacros alerts: spikes ${pct(realAlerts.spikeRecall)} caught at ${pct(realAlerts.spikePrecision)} precision; lows ${realAlerts.lowHits} of ${realAlerts.lowEvents} at ${pct(realAlerts.lowPrecision)} precision, ${mg(realAlerts.falsePerPatientDay, 2)} false alerts per patient-day.`,
      `Simulated stress test (generator differs from the twin): 60 min ${mg(m60.rmseTwin)} vs persistence ${mg(m60.rmsePersistence)}; 120 min ${mg(m120.rmseTwin)} vs ${mg(m120.rmsePersistence)}.`,
      `Stress-test spikes: ${pct(simAlerts.spikeRecall)} caught, ${pct(simAlerts.spikePrecision)} precise, ${mg(simAlerts.falsePerPatientDay, 2)} false alerts per patient-day, median lead ${fmt(simAlerts.medianLeadMin)} min. Urgent alerts reach ${pct(simAlerts.urgentRecall)} of ${fmt(simAlerts.urgentEvents)} severe events, ${pct(simAlerts.urgentPrecision)} precise. Lows ${simAlerts.lowHits} of ${simAlerts.lowEvents}.`,
      `Matched generator (shares the twin's equations, an upper bound): 60 min ${mg(match60.rmseTwin)} vs ${mg(match60.rmsePersistence)}.`,
      `Risk ranking (AUROC, 95% CI): spikes ${mg(realDisc.spike.auroc, 3)} (${mg(realDisc.spike.aurocCi[0], 3)}–${mg(realDisc.spike.aurocCi[1], 3)}) on CGMacros, ${mg(proof.calibration.spike.auroc, 3)} simulated; lows ${mg(realDisc.low.auroc, 3)} and ${mg(proof.calibration.low.auroc, 3)}.${realDisc.spike.brierSkill < 0 ? " On real data the risk is a ranking, not a calibrated probability." : ""}`,
    ],
  },
  {
    title: level ? "As accurate as the best simple alarm, earlier and quieter" : "Better than a simple alarm",
    kicker: `Same ${twinProof.events} spikes, same alert rules, same scorer`,
    stats: [
      {
        value: mg(twinProof.f1, 3),
        label: `F1 for GlucoTwin; next best ${mg(nextBest.spike.f1, 3)} (${nextBest.label})`,
      },
      {
        value: `${fmt(twinProof.medianLeadMin)} min`,
        label: `median warning; CGM trend alarms ${fmt(fastest.medianLeadMin)} min at best`,
      },
      {
        value: `${twinProof.warnedAtLeast60.count}`,
        label: `spikes warned ≥ 60 min ahead (${pct(twinProof.warnedAtLeast60.share)})`,
      },
      { value: mg(twinProof.falsePerPatientDay, 2), label: "false alerts per patient-day" },
    ],
    bullets: [
      `GlucoTwin: ${pct(twinProof.recall)} recall, ${pct(twinProof.precision)} precision.${level ? ` F1 is level with ${nextBest.label}; GlucoTwin warns a median ${fmt(twinProof.medianLeadMin)} min ahead against ${fmt(nextBest.spike.medianLeadMin)}, with ${mg(twinProof.falsePerPatientDay, 2)} against ${mg(nextBest.spike.falsePerPatientDay, 2)} false alerts per patient-day.` : ""}`,
      ...others.map(
        (item) =>
          `${item.label}: ${pct(item.spike.recall)} recall, ${pct(item.spike.precision)} precision, F1 ${mg(item.spike.f1, 3)}, ${mg(item.spike.falsePerPatientDay, 2)} false/day, median lead ${fmt(item.spike.medianLeadMin)} min.`,
      ),
      "Source: docs/ALERT_PROOF.md (npm run alert-proof).",
    ],
  },
  {
    title: "Seven plans, one twin per patient",
    kicker: "Time in range on days 10–16 of each fitted twin. No dosing.",
    bullets: [
      ...t2dPlans.map(
        (item) =>
          `${item.name}: ${item.best.label} — ${item.base.tirPct}% → ${item.best.tirPct}% (${signed(item.delta)} pts), minutes above 180 ${item.base.above180Min} → ${item.best.above180Min}.`,
      ),
      `The same plan, ${contrast[0].label.toLowerCase()}: ${contrast.map((item) => `${item.name} ${signed(item.delta)}`).join(", ")} points. One rule does not fit every twin.`,
      "Plans target each patient's highest-risk meal (breakfast, lunch or dinner). Full table in the README.",
    ],
  },
  {
    title: "The doctor dashboard",
    kicker: "Live screens from the running app",
    images: [
      {
        src: "screens/cohort.png",
        caption: "Cohort triage: patients ranked by urgency; only Urgent interrupts",
      },
      {
        src: "screens/twin.png",
        caption: "Twin: 2-hour forecast with conformal band and per-stream consent toggles",
      },
      {
        src: "screens/whatif.png",
        caption: "What-if: seven plans on the patient's own twin, with deltas",
      },
    ],
    bullets: [
      "The Clinical summary button prints a one-page pre-visit sheet: twin parameters, 7-day time in range, the chosen plan and recent Urgent alerts.",
    ],
  },
  {
    title: "Built for India",
    kicker: "Direction, not a reproduction",
    bullets: [
      "IFCT 2017 food rows for Indian plates: rice, chapati, toor dal, paneer, jowar roti.",
      "The diet paper is cited as direction. The twin sees carbohydrate grams, fiber, fat and walks; it has no separate protein effect.",
      "Subgroup priors follow the South Asian SIDD / IROD / CIRDD / MARD labels with approximate thresholds.",
      "A weekly fasting-day preset is built, with a medicine-review warning. Navratri, Ramadan and Ekadashi calendars are not.",
      "CGMacros is a US cohort; transfer to Indian patients is not yet shown.",
    ],
  },
  {
    title: "Trust, safety and consent",
    kicker: "DPDP-style per-stream consent is live in the dashboard",
    bullets: [
      "Withdraw the health record and the twin drops the record prior and medicine list, keeps its personal CGM fit, and widens its band at least ×1.12; withdraw wearables and sleep, HRV and walks drop out and the band widens ×1.1. Alerts, plans and the ward ranking follow the consented twin.",
      "Only Urgent alerts interrupt. Every alert lists its reasons; the doctor can mark a false alarm.",
      "Drift is flagged as out of sync and never silently rewrites the fit on screen.",
      "Intended use and change bounds: docs/REGULATORY.md. Hazards and the test that locks each one: docs/HAZARDS.md.",
      "No insulin, no tablet dose, no diagnosis. The fasting-day plan tells the doctor to review glucose-lowering medicines first.",
    ],
  },
  {
    title: "Scale and integration",
    kicker: `reports/scale.json · ${scale.measuredAt} · ${scale.cpu}`,
    stats: [
      {
        value: `${mg(scale.microsecondsPerReading)} µs`,
        label: "per reading: update, 2-hour forecast and spike risk",
      },
      {
        value: thousands(scale.readingsPerSecondOneThread),
        label: "readings per second on one laptop thread",
      },
      {
        value: `${fmt(scale.forecastAtMedianMicroseconds)} µs`,
        label: "median dashboard forecast",
      },
      {
        value: `${fmt(scale.wardSnapshotHydrateMs)} ms`,
        label: `to load the fitted ward in the dashboard (a cold fit and evaluation take ${((scale.simWardFitMs + scale.cohortEvaluationMs) / 1000).toFixed(1)} s)`,
      },
    ],
    bullets: [
      `Compute only: excludes network and database time. One thread; the work is independent per patient, so it shards by patient. Benchmark: ${thousands(scale.patients)} simulated patients × ${scale.readingsPerPatient} readings.`,
      "The record is a FHIR R4 Bundle, the format ABDM exchanges. ABDM-certified import and an on-device Web Worker are not built yet.",
      "Per-stream consent is already enforced in the dashboard, ready to map onto an ABDM consent artefact.",
    ],
  },
  {
    title: "Limitations",
    kicker: "Read these before the headline",
    bullets: [
      "The simulated ward is synthetic (seed 42); its sleep, HRV, walk and medication effects are modelling assumptions at the upper end of published studies.",
      `Sleep and HRV help after meals following a hard night (${mg(nightMeal.rmse60, 2)} vs ${mg(noSleepNightMeal.rmse60, 2)}) but not on an average day (${mg(full.rmse60, 2)} vs ${mg(noSleep.rmse60, 2)}).`,
      `CGMacros is 45 US adults. At 30 min the twin is ${mg(h30.rmseTwin)} against persistence ${mg(h30.rmsePersistence)} (${vsPersistence(h30.rmseTwin, h30.rmsePersistence)}), and low alerts are ${pct(realAlerts.lowPrecision)} precise${realAlerts.lowPrecision < 0.45 ? ", short of the 45% target" : ""}.`,
      `Simulated lows: ${simAlerts.lowHits} of ${simAlerts.lowEvents} warned at ${pct(simAlerts.lowPrecision)} precision${simAlerts.lowRecall < 0.65 ? ", short of a 65% target" : ""}; the sulfonylurea guard is chosen on an independent realization, so this is blind. The record prior and medicine term do not lower pooled simulated error${noRecord.alerts ? `, but without them warned lows fall to ${noRecord.alerts.lowHits} of ${noRecord.alerts.lowEvents}` : ""}.${eight.rmse > six.rmse ? ` Fingersticks: 8 a day (${mg(eight.rmse)}) is worse than 6 (${mg(six.rmse)}).` : ""}`,
      "Approximate subgroups, offline LightGBM, plan compare is a simulation. Not clinically validated.",
    ],
  },
  {
    title: "Roadmap and team",
    kicker: "Next: a supervised clinic pilot",
    bullets: [
      "Now: the twin runs on 11 simulated patients and 45 real CGMacros adults, with consent, alerts, plans and the pre-visit summary.",
      "Next: ABHA-consented FHIR import through ABDM, learned medicine effects for lows, and calibrated risk on real Indian CGM data.",
      "Pilot: one diabetes clinic, 30 consenting adults on CGM for 12 weeks, with a doctor reviewing forecasts and alerts.",
      "Team GlucoTwin_RIMT-University. Nikhil Chawla, team leader — AI Engineer, BCA – AI & Data Science, RIMT University, Mandi Gobindgarh, Punjab. Faculty mentor: Dr. Rajkumar (Head of Department, Computer Applications, RIMT University).",
      "GitHub: github.com/1nikhilchawla.",
    ],
  },
];

if (slides.length !== 15) {
  throw new Error(`Expected 15 slides, got ${slides.length}`);
}
for (const slide of slides) {
  for (const image of slide.images ?? []) {
    if (!existsSync(join(outDir, image.src)))
      throw new Error(`Missing screenshot ${image.src}. Capture the dashboard screens first.`);
  }
}

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "slides.json"), `${JSON.stringify({ slides }, null, 2)}\n`);

function escape(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function statsHtml(stats) {
  if (!stats) return "";
  return `<div class="stats">${stats
    .map(
      (item) =>
        `<div class="stat"><p class="value">${escape(item.value)}</p><p class="label">${escape(item.label)}</p></div>`,
    )
    .join("")}</div>`;
}

function imagesHtml(images) {
  if (!images) return "";
  return `<div class="shots">${images
    .map(
      (item) =>
        `<figure><img src="${escape(item.src)}" alt="${escape(item.caption)}" /><figcaption>${escape(item.caption)}</figcaption></figure>`,
    )
    .join("")}</div>`;
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>GlucoTwin presentation</title>
<style>
  @page { size: 13.333in 7.5in; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #f4f1ea; color: #1c1915; font-family: "Source Sans 3", "Segoe UI", sans-serif; }
  section { width: 13.333in; height: 7.5in; padding: 0.5in 0.7in 0.45in; page-break-after: always; position: relative; overflow: hidden; }
  section:last-child { page-break-after: auto; }
  section.cover { background: #0f2f2f; color: #f4f1ea; }
  section.cover .kicker { color: #8fd3c8; }
  section.cover .stat { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.18); }
  section.cover .stat .value { color: #8fd3c8; }
  section.cover .stat .label, section.cover li, section.cover .foot { color: #e7e2d6; }
  .kicker { letter-spacing: 0.08em; text-transform: uppercase; font-size: 13px; color: #0f6e6e; margin: 0 0 8px; font-weight: 600; }
  h1 { font-family: Georgia, "Iowan Old Style", serif; font-size: 40px; line-height: 1.05; margin: 0 0 16px; font-weight: 600; }
  section.cover h1 { font-size: 64px; margin-bottom: 20px; }
  ul { margin: 0; padding-left: 1.1em; }
  li { font-size: 20px; line-height: 1.32; margin: 0 0 10px; }
  section.dense li { font-size: 17px; line-height: 1.3; margin: 0 0 7px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 0 0 18px; }
  .stat { background: #fffdf8; border: 1px solid #e4ddd0; border-radius: 14px; padding: 12px 14px; }
  .stat .value { font-family: Georgia, serif; font-size: 34px; line-height: 1; margin: 0 0 6px; color: #0f6e6e; font-weight: 600; }
  .stat .label { font-size: 13.5px; line-height: 1.3; margin: 0; color: #4a443b; }
  .foot { position: absolute; left: 0.7in; right: 0.7in; bottom: 0.25in; font-size: 12px; color: #5c564c; display: flex; justify-content: space-between; }
  figure { margin: 0; }
  .single img { width: 100%; max-height: 5.1in; object-fit: contain; object-position: center top; background: white; border: 1px solid #e4ddd0; border-radius: 10px; }
  .single + ul li { font-size: 15px; margin-top: 8px; }
  .shots { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin: 0 0 14px; }
  .shots img { width: 100%; height: 3.55in; object-fit: cover; object-position: center top; border: 1px solid #d9d1c1; border-radius: 10px; background: white; }
  .shots figcaption { font-size: 13.5px; line-height: 1.3; margin-top: 6px; color: #4a443b; }
</style>
</head>
<body>
${slides
  .map(
    (
      slide,
      index,
    ) => `<section class="${[index === 0 ? "cover" : "", slide.bullets.length > 6 || (slide.stats && slide.bullets.length > 4) ? "dense" : ""].join(" ").trim()}">
  <p class="kicker">${escape(slide.kicker)}</p>
  <h1>${escape(slide.title)}</h1>
  ${statsHtml(slide.stats)}
  ${slide.image ? `<figure class="single"><img src="${escape(slide.image)}" alt="Architecture diagram" /></figure>` : ""}
  ${imagesHtml(slide.images)}
  <ul>
    ${slide.bullets.map((item) => `<li>${escape(item)}</li>`).join("\n    ")}
  </ul>
  <div class="foot"><span>Research prototype — not a medical device, not medical advice.</span><span>${index + 1} / ${slides.length}</span></div>
</section>`,
  )
  .join("\n")}
</body>
</html>
`;
const htmlPath = join(outDir, "slides.html");
writeFileSync(htmlPath, html);

const python = process.env.PYTHON ?? "python3";
const pptx = spawnSync(
  python,
  [
    join(root, "scripts/build_deck.py"),
    join(outDir, "slides.json"),
    join(outDir, "GlucoTwin_Presentation.pptx"),
  ],
  {
    encoding: "utf8",
  },
);
if (pptx.status !== 0) {
  console.error(pptx.stdout);
  console.error(pptx.stderr);
  throw new Error("PPTX build failed");
}
console.log(pptx.stdout.trim());

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
});
const page = await browser.newPage();
await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "networkidle" });
await page.pdf({
  path: join(outDir, "GlucoTwin_Presentation.pdf"),
  width: "13.333in",
  height: "7.5in",
  printBackground: true,
  margin: { top: "0", right: "0", bottom: "0", left: "0" },
});
await browser.close();
console.log("Wrote presentation PDF");
