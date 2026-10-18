/**
 * Writes reports/sim_eval.json from the simulated cohort, then rewrites only
 * the README block between the RESULTS markers. Numbers in that block are
 * printed from the JSON files, not typed in the README.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DAYS, STEPS_PER_DAY, getCohort } from "../src/lib/glucotwin/cohort.ts";
import { wilson } from "../src/lib/glucotwin/ehr.ts";
import { findGlucoseEvents, STEP_MIN } from "../src/lib/glucotwin/physics.ts";
import { rankPlans } from "../src/lib/glucotwin/protocol.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = join(root, "README.md");
const simPath = join(root, "reports", "sim_eval.json");
const realPath = join(root, "src/lib/glucotwin/real/real_eval.json");
const scalePath = join(root, "reports", "scale.json");
const proofPath = join(root, "reports", "alert_proof.json");

function glucoseAt(readings, index) {
  const reading = readings[index];
  if (!reading || reading.cgmGap || reading.compressionLow) return null;
  return reading.glucose;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function leadShares(models, from) {
  const spikeLeads = [];
  const lowLeads = [];
  let spikeEvents = 0;
  let lowEvents = 0;
  const spikeWindow = Math.round(120 / STEP_MIN);
  const lowWindow = Math.round(60 / STEP_MIN);
  for (const model of models) {
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
    const found = findGlucoseEvents(points, meals, STEP_MIN);
    const spikes = found.spikes.filter((index) => index >= from);
    const lows = found.lows.filter((index) => index >= from);
    spikeEvents += spikes.length;
    lowEvents += lows.length;
    const alerts = model.alerts
      .filter((alert) => alert.index >= from)
      .map((alert) => ({ index: alert.index, kind: alert.kind }));
    for (const event of spikes) {
      const prior = alerts.filter(
        (alert) =>
          alert.kind === "spike" && alert.index >= event - spikeWindow && alert.index < event,
      );
      if (!prior.length) continue;
      const first = Math.min(...prior.map((alert) => alert.index));
      spikeLeads.push((event - first) * STEP_MIN);
    }
    for (const event of lows) {
      const prior = alerts.filter(
        (alert) => alert.kind === "low" && alert.index >= event - lowWindow && alert.index < event,
      );
      if (!prior.length) continue;
      const first = Math.min(...prior.map((alert) => alert.index));
      lowLeads.push((event - first) * STEP_MIN);
    }
  }
  const share = (leads, events, min) => {
    const count = leads.filter((lead) => lead >= min).length;
    return {
      atLeastMin: min,
      count,
      events,
      share: events ? round3(count / events) : null,
    };
  };
  return {
    note: "Share of events whose first matching alert falls inside the scorer window and is at least this many minutes earlier. Spike window is 120 min. Low window is 60 min. A miss counts as not warned. This is not a share beyond the window.",
    spikeEvents,
    lowEvents,
    spikeHits: spikeLeads.length,
    lowHits: lowLeads.length,
    spikeAtLeast60: share(spikeLeads, spikeEvents, 60),
    spikeAtLeast120: share(spikeLeads, spikeEvents, 120),
    lowAtLeast60: share(lowLeads, lowEvents, 60),
  };
}

function interval(hits, n) {
  const band = wilson(hits, n);
  if (!band) return null;
  return [round3(band[0]), round3(band[1])];
}

function withWilson(alerts) {
  return {
    ...alerts,
    spikeRecallWilson: interval(alerts.spikeHits, alerts.spikeEvents),
    spikePrecisionWilson: interval(alerts.spikeTrue, alerts.spikeAlerts),
    lowRecallWilson: interval(alerts.lowHits, alerts.lowEvents),
    lowPrecisionWilson: interval(alerts.lowTrue, alerts.lowAlerts),
    // Urgent recall is scored against clinically severe events (urgentEvents); the all-event
    // figure is kept, labelled, for comparison with earlier runs.
    urgentRecallWilson: interval(alerts.urgentHits, alerts.urgentEvents),
    urgentRecallAllEventsWilson: interval(
      alerts.urgentHitsAllEvents,
      (alerts.spikeEvents ?? 0) + (alerts.lowEvents ?? 0),
    ),
    urgentPrecisionWilson: interval(alerts.urgentTrue, alerts.urgentAlerts),
  };
}

function evalBlock(block) {
  return {
    generator: block.generator,
    horizons: block.horizons,
    groups: block.groups,
    alerts: withWilson(block.alerts),
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function cell(value) {
  if (value == null) return "—";
  return String(value);
}

function mg(value) {
  if (value == null || typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toFixed(1);
}

function band(pair) {
  if (!pair) return "—";
  return `${pair[0]} to ${pair[1]}`;
}

function horizonTable(label, horizons) {
  const lines = [
    `| Tier | Horizon (min) | Twin RMSE | Persistence RMSE | Population RMSE | MAE | MARD | Coverage | Clarke A+B | n |`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |`,
  ];
  for (const row of horizons) {
    lines.push(
      `| ${label} | ${cell(row.horizonMin)} | ${mg(row.rmseTwin)} | ${mg(row.rmsePersistence)} | ${mg(row.rmsePopulation)} | ${mg(row.mae)} | ${mg(row.mard)} | ${cell(row.coverage)} | ${cell(row.clarkeApb)} | ${cell(row.n)} |`,
    );
  }
  return lines.join("\n");
}

function groupTable(label, groups) {
  const lines = [
    `| Tier | Group | Patients | 60-min twin RMSE | 60-min persistence RMSE | Improvement % |`,
    `| --- | --- | ---: | ---: | ---: | ---: |`,
  ];
  for (const row of groups) {
    lines.push(
      `| ${label} | ${cell(row.group)} | ${cell(row.patients)} | ${mg(row.rmse60)} | ${mg(row.rmse60Persistence)} | ${mg(row.improvementPct)} |`,
    );
  }
  return lines.join("\n");
}

function alertTable(label, alerts, leads) {
  const lines = [
    `| Tier | Kind | Events | Alerts | Hits | Recall | Recall Wilson 95% | Precision | Precision Wilson 95% | False alerts / patient-day | Median lead (min) | Lead IQR (min) |`,
    `| --- | --- | ---: | ---: | ---: | ---: | --- | ---: | --- | ---: | ---: | --- |`,
  ];
  lines.push(
    `| ${label} | Spike | ${cell(alerts.spikeEvents)} | ${cell(alerts.spikeAlerts)} | ${cell(alerts.spikeHits)} | ${cell(alerts.spikeRecall)} | ${band(alerts.spikeRecallWilson)} | ${cell(alerts.spikePrecision)} | ${band(alerts.spikePrecisionWilson)} | ${fixed(alerts.falsePerPatientDay, 2)} | ${cell(alerts.medianLeadMin)} | ${alerts.leadIqrMin ? `${alerts.leadIqrMin[0]} to ${alerts.leadIqrMin[1]}` : "—"} |`,
  );
  lines.push(
    `| ${label} | Low | ${cell(alerts.lowEvents)} | ${cell(alerts.lowAlerts)} | ${cell(alerts.lowHits)} | ${cell(alerts.lowRecall)} | ${band(alerts.lowRecallWilson)} | ${cell(alerts.lowPrecision)} | ${band(alerts.lowPrecisionWilson)} | ${fixed(alerts.falsePerPatientDay, 2)} | — | — |`,
  );
  if (alerts.urgentAlerts != null) {
    lines.push(
      `| ${label} | Urgent, severe events (peak > 250, ≥ 60 min > 180, or a low) | ${cell(alerts.urgentEvents)} | ${cell(alerts.urgentAlerts)} | ${cell(alerts.urgentHits)} | ${cell(alerts.urgentRecall)} | ${band(alerts.urgentRecallWilson)} | ${cell(alerts.urgentPrecision)} | ${band(alerts.urgentPrecisionWilson)} | ${fixed(alerts.urgentPerPatientDay, 1)} | — | — |`,
    );
    lines.push(
      `| ${label} | Urgent, all events (for comparison) | ${cell((alerts.spikeEvents ?? 0) + (alerts.lowEvents ?? 0))} | ${cell(alerts.urgentAlerts)} | ${cell(alerts.urgentHitsAllEvents)} | ${cell(alerts.urgentRecallAllEvents)} | ${band(alerts.urgentRecallAllEventsWilson)} | — | — | — | — | — |`,
    );
    lines.push(
      `| ${label} | Watch alerts | — | ${cell(alerts.watchAlerts)} | — | — | — | — | — | ${mg(alerts.watchPerPatientDay)} | — | — |`,
    );
  }
  if (leads) {
    lines.push("");
    lines.push(
      `Spike events with a first alert at least 60 min earlier: ${cell(leads.spikeAtLeast60.count)} of ${cell(leads.spikeAtLeast60.events)} (share ${cell(leads.spikeAtLeast60.share)}). At least 120 min: ${cell(leads.spikeAtLeast120.count)} of ${cell(leads.spikeAtLeast120.events)} (share ${cell(leads.spikeAtLeast120.share)}). Low events at least 60 min: ${cell(leads.lowAtLeast60.count)} of ${cell(leads.lowAtLeast60.events)} (share ${cell(leads.lowAtLeast60.share)}). ${leads.note}`,
    );
  }
  return lines.join("\n");
}

function fixed(value, digits) {
  if (value == null || typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function ablationTable(rows, digits = 1) {
  const withAlerts = rows.some((row) => row.alerts);
  const lines = withAlerts
    ? [
        `| Id | Label | 60-min RMSE | n | Spike F1 | Lows warned | Urgent recall (severe events) |`,
        `| --- | --- | ---: | ---: | ---: | ---: | ---: |`,
      ]
    : [`| Id | Label | 60-min RMSE | n |`, `| --- | --- | ---: | ---: |`];
  for (const row of rows) {
    const base = `| ${cell(row.id)} | ${cell(row.label)} | ${fixed(row.rmse60, digits)} | ${cell(row.n)} |`;
    if (!withAlerts) {
      lines.push(base);
      continue;
    }
    const a = row.alerts;
    lines.push(
      a
        ? `${base} ${fixed(a.spikeF1, 3)} | ${a.lowHits} of ${a.lowEvents} | ${a.urgentHits} of ${a.urgentEvents} (${fixed(a.urgentRecall, 3)}) |`
        : `${base} — | — | — |`,
    );
  }
  return lines.join("\n");
}

function discriminationTable(rows) {
  const lines = [
    "| Data | Risk | Scored steps | Base rate | AUROC (95% CI) | AUPRC (95% CI) | Brier (always base rate) | ECE |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [label, kind, d] of rows) {
    if (!d) continue;
    const ci = (value, band) => `${fixed(value, 3)} (${band ? `${fixed(band[0], 3)}–${fixed(band[1], 3)}` : "—"})`;
    lines.push(
      `| ${label} | ${kind} | ${cell(d.steps)} | ${fixed(d.baseRate, 4)} | ${ci(d.auroc, d.aurocCi)} | ${ci(d.auprc, d.auprcCi)} | ${fixed(d.brier, 4)} (${fixed(d.brierClimatology, 4)}) | ${fixed(d.ece ?? d.expectedCalibrationError, 3)} |`,
    );
  }
  return lines.join("\n");
}

/** Compares at the printed precision, so "higher" never sits between two equal numbers. */
function compareArms(rows, leftId, rightId, leftName, rightName, digits = 1) {
  const left = rows.find((row) => row.id === leftId);
  const right = rows.find((row) => row.id === rightId);
  if (!left || !right) return null;
  const a = fixed(left.rmse60, digits);
  const b = fixed(right.rmse60, digits);
  if (a === b) {
    return `${leftName} and ${rightName} have the same stored 60-min RMSE (${a}).`;
  }
  if (left.rmse60 > right.rmse60) {
    return `${leftName} 60-min RMSE ${a} is higher than ${rightName} ${b}.`;
  }
  return `${leftName} 60-min RMSE ${a} is lower than ${rightName} ${b}.`;
}

function render(sim, real, scale) {
  const parts = [];
  parts.push(
    "Tables below are printed from `reports/sim_eval.json` and `src/lib/glucotwin/real/real_eval.json`. RMSE, MAE and MARD are mg/dL. Coverage and recall are fractions from 0 to 1. A dash means that field is not stored.",
  );
  parts.push("");
  parts.push("### Forecast accuracy");
  parts.push("");
  parts.push(horizonTable("CGMacros (real)", real.horizons));
  parts.push("");
  parts.push(horizonTable("Simulated mismatched", sim.mismatched.horizons));
  parts.push("");
  parts.push(horizonTable("Simulated matched (upper bound)", sim.matched.horizons));
  parts.push("");
  const tie = real.horizons.find((row) => row.horizonMin === 30);
  if (tie && tie.rmseTwin === tie.rmsePersistence) {
    parts.push(
      `At 30 min on CGMacros the twin RMSE (${tie.rmseTwin}) is tied with persistence (${tie.rmsePersistence}). n = ${tie.n}.`,
    );
    parts.push("");
  } else if (tie && tie.rmseTwin > tie.rmsePersistence) {
    parts.push(
      `At 30 min on CGMacros the twin RMSE (${tie.rmseTwin}) is higher than persistence (${tie.rmsePersistence}): carrying the last reading forward is the better 30-min forecast there. n = ${tie.n}.`,
    );
    parts.push("");
  }
  const choices = [];
  if (real.mealResidual) {
    choices.push(
      `Meal-scaled residual ${real.mealResidual.chosen === "scaled" ? "on" : "off"} (validation 60-min RMSE ${cell(real.mealResidual.validationRmse60?.scaled)} scaled, ${cell(real.mealResidual.validationRmse60?.plain)} plain).`,
    );
  }
  if (real.mealClock) {
    choices.push(
      `Meal clock and size factors ${real.mealClock.chosen ? "on" : "off"} for CGMacros (validation 60-min RMSE ${cell(real.mealClock.validationRmse60?.on)} on, ${cell(real.mealClock.validationRmse60?.off)} off).`,
    );
  }
  if (real.personalTrust?.counts) {
    const counts = Object.entries(real.personalTrust.counts)
      .map(([level, n]) => `${level}: ${n}`)
      .join(", ");
    choices.push(`Personal weight per participant (${counts}).`);
  }
  if (real.trendCorrection) {
    choices.push(
      `Trend correction pooled on everyone's uncorrected test rows: ${["30", "60", "120"].map((h) => `${h} min gain ${cell(real.trendCorrection[h]?.slopeGain)}, bias ${cell(real.trendCorrection[h]?.bias)}`).join("; ")}. Each participant's own forecast uses leave-one-participant-out coefficients, and their band is refit after the correction.`,
    );
  }
  if (choices.length) {
    parts.push(`CGMacros choices, all made on validation days 5–6: ${choices.join(" ")}`);
    parts.push("");
  }
  if (sim.mealResidual) {
    parts.push(
      `Simulated ward, validation days 6–9: meal-scaled residual ${sim.mealResidual.chosen === "scaled" ? "on" : "off"} (60-min RMSE ${cell(sim.mealResidual.validationRmse60?.scaled)} scaled, ${cell(sim.mealResidual.validationRmse60?.plain)} plain).`,
    );
    parts.push("");
  }
  parts.push("### Groups at 60 min");
  parts.push("");
  parts.push(groupTable("CGMacros (real)", real.groups));
  parts.push("");
  parts.push(groupTable("Simulated mismatched", sim.mismatched.groups));
  parts.push("");
  parts.push("### Alerts");
  parts.push("");
  parts.push(
    "Wilson 95% intervals use the stored hit counts. False alerts per patient-day on the low row is the same pooled figure as the spike row. Lead time is reported for spikes only. The scorer counts an alert as a hit only inside its window (120 min before a spike, 60 min before a low), so no reported lead can exceed 120 min. Urgent recall counts an alert from the moment it became Urgent, including a Watch upgraded in place. On CGMacros the low risk also includes a guarded CGM trend rule. The rule and its guard values are chosen leave-one-participant-out: each participant is scored with the candidate that did best on the other participants (`lowRule` in `real_eval.json`), so no participant's own test days choose their rule. On the simulated ward the sulfonylurea low guard is chosen on an independent realization of the ward (`reports/drug_guard_calibration.json`), so the scored days never informed it.",
  );
  parts.push("");
  parts.push(alertTable("CGMacros (real)", withWilson(real.alerts), null));
  const shares = real.alerts.spikeLeadShares;
  if (shares) {
    parts.push("");
    parts.push(
      `CGMacros spike events warned at least 30 min ahead: ${cell(shares.atLeast30.count)} of ${cell(shares.atLeast30.events)} (share ${cell(shares.atLeast30.share)}). At least 60 min: ${cell(shares.atLeast60.count)} (share ${cell(shares.atLeast60.share)}). At least 120 min: ${cell(shares.atLeast120?.count)} (share ${cell(shares.atLeast120?.share)}).`,
    );
  }
  parts.push("");
  parts.push(alertTable("Simulated mismatched", sim.mismatched.alerts, sim.leadShares));
  parts.push("");
  parts.push("Discrimination and calibration of the continuous risk the alerts threshold. Steps are 5-min test-day steps where the outcome is defined (at or under 180 for spikes, at or over 70 for lows). Intervals come from a participant (CGMacros) or patient (simulated) bootstrap.");
  parts.push("");
  parts.push(
    discriminationTable([
      ["CGMacros (real)", "Spike, next 120 min", real.alerts.discrimination?.spike],
      ["CGMacros (real)", "Low, next 60 min", real.alerts.discrimination?.low],
      ["Simulated mismatched", "Spike, next 120 min", proof?.calibration?.spike],
      ["Simulated mismatched", "Low, next 60 min", proof?.calibration?.low],
    ]),
  );
  parts.push("");
  parts.push("### Cold-start ablation (60-min RMSE)");
  parts.push("");
  parts.push("CGMacros ridge ablation. The ridge is not shifted by the cluster rule.");
  parts.push("");
  parts.push(ablationTable(real.ablation));
  parts.push("");
  parts.push("Simulated ward. The record arm includes the approximate cluster shift.");
  parts.push("");
  parts.push(ablationTable(sim.ablation));
  parts.push("");
  const clusterLine = compareArms(sim.ablation, "ehr", "group", "Record + cluster", "Group only");
  if (clusterLine) parts.push(clusterLine, "");
  parts.push("Streams removed one at a time on the simulated mismatched ward. For the six main arms the alerts are rebuilt with that arm's knobs, stream mask and medicine term (no cached risk) and scored on days 10–21.");
  parts.push("");
  parts.push(ablationTable(sim.streamAblation, 2));
  parts.push("");
  for (const line of [
    compareArms(sim.streamAblation, "noMeals", "full", "No meals", "Full", 2),
    compareArms(sim.streamAblation, "noActivity", "full", "No activity", "Full", 2),
    compareArms(sim.streamAblation, "noSleep", "full", "No sleep", "Full", 2),
    compareArms(sim.streamAblation, "noRecord", "full", "No record (group prior + personal fit, no medicine term)", "Full", 2),
    compareArms(sim.streamAblation, "noRecordNoPersonal", "full", "No record and no personal fit", "Full", 2),
    compareArms(
      sim.streamAblation,
      "noSleepHardNightMeal",
      "fullHardNightMeal",
      "No sleep, 2 h after a meal following a hard night,",
      "Full",
      2,
    ),
    compareArms(
      sim.streamAblation,
      "noActivityAfterWalk",
      "fullAfterWalk",
      "No activity, 6 h after a walk,",
      "Full",
      2,
    ),
  ]) {
    if (line) parts.push(line);
  }
  parts.push("");
  parts.push("### Low-cost fingersticks");
  parts.push("");
  parts.push(
    "RMSE of interpolating a few daily fingersticks against the full CGM grid on the simulated ward. This is not the twin's forecast error.",
  );
  parts.push("");
  parts.push("| Pricks per day | RMSE |");
  parts.push("| ---: | ---: |");
  for (const row of sim.lowCost) parts.push(`| ${cell(row.pricks)} | ${mg(row.rmse)} |`);
  parts.push("");
  const six = sim.lowCost.find((row) => row.pricks === 6);
  const eight = sim.lowCost.find((row) => row.pricks === 8);
  if (six && eight && eight.rmse > six.rmse) {
    parts.push(
      `8 pricks (RMSE ${mg(eight.rmse)}) is worse than 6 pricks (RMSE ${mg(six.rmse)}) on this score.`,
    );
    parts.push("");
  }
  if (sim.habitRecall != null && sim.habitRecall === sim.mismatched.alerts.spikeRecall) {
    parts.push(
      `Usual-meal prior spike recall (${sim.habitRecall}) matches the stored spike recall (${sim.mismatched.alerts.spikeRecall}). Median lead ${cell(sim.habitLeadMin)} min versus stored median lead ${cell(sim.mismatched.alerts.medianLeadMin)} min.`,
    );
    parts.push("");
  }
  parts.push("### Personal 60-min RMSE");
  parts.push("");
  parts.push(
    "Gain is population RMSE minus this person's twin RMSE. A negative gain is worse than the group prior.",
  );
  parts.push("");
  parts.push("| Id | Name | Group | Cluster | Twin RMSE | Population RMSE | Gain |");
  parts.push("| --- | --- | --- | --- | ---: | ---: | ---: |");
  for (const row of sim.personal) {
    parts.push(
      `| ${cell(row.id)} | ${cell(row.name)} | ${cell(row.group)} | ${cell(row.cluster)} | ${mg(row.rmse60)} | ${mg(row.rmse60Pop)} | ${mg(row.gain)} |`,
    );
  }
  parts.push("");
  parts.push("### Protocol compare (simulated, days 10–16, 5-min grid)");
  parts.push("");
  parts.push(
    "Ranked on the fitted twin. Each plan edits the patient's highest-risk meal slot. No dosing. As-logged stays first. The other rows follow the gain in `rankPlans`: one point of time in range equals 14.4 minutes above 180, and a minute under 70 counts as 3 minutes above 180 (6 for a patient on a glucose-lowering drug or with lows in the as-logged week).",
  );
  parts.push("");
  parts.push("| Id | Name | Plan | Time in range % | Min above 180 | Min under 70 | Mean mg/dL |");
  parts.push("| --- | --- | --- | ---: | ---: | ---: | ---: |");
  for (const person of sim.protocols) {
    for (const plan of person.plans) {
      parts.push(
        `| ${cell(person.id)} | ${cell(person.name)} | ${cell(plan.label)} | ${cell(plan.tirPct)} | ${cell(plan.above180Min)} | ${cell(plan.below70Min)} | ${cell(plan.meanGlucose)} |`,
      );
    }
  }
  parts.push("");
  parts.push("### Offline LightGBM residual (CGMacros only, not on the live curve)");
  parts.push("");
  parts.push(
    "| Horizon (min) | CV twin RMSE | CV hybrid RMSE | Held-out people | Held-out twin RMSE | Held-out hybrid RMSE |",
  );
  parts.push("| ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const key of ["30", "60", "120"]) {
    const row = real.hybrid?.[key];
    if (!row) continue;
    parts.push(
      `| ${key} | ${mg(row.rmseTwin)} | ${mg(row.rmseHybrid)} | ${cell(row.heldoutParticipants)} | ${mg(row.heldoutTwin)} | ${mg(row.heldoutHybrid)} |`,
    );
  }
  parts.push("");
  parts.push("### Scale");
  parts.push("");
  if (!scale) {
    parts.push(
      "A scale benchmark is not in this build. `reports/scale.json` is absent, so no throughput number is reported.",
    );
  } else {
    parts.push("| Field | Value |");
    parts.push("| --- | --- |");
    for (const [key, value] of Object.entries(scale)) {
      if (value != null && typeof value !== "object") parts.push(`| ${key} | ${cell(value)} |`);
    }
  }
  parts.push("");
  return parts.join("\n");
}

console.error("Building simulated cohort…");
const cohort = getCohort();
const from = (DAYS - cohort.eval.alerts.evalDays) * STEPS_PER_DAY;
const leads = leadShares(cohort.patients, from);
if (
  leads.spikeEvents !== cohort.eval.alerts.spikeEvents ||
  leads.lowEvents !== cohort.eval.alerts.lowEvents
) {
  throw new Error(
    `Event recount ${leads.spikeEvents}/${leads.lowEvents} does not match eval ${cohort.eval.alerts.spikeEvents}/${cohort.eval.alerts.lowEvents}`,
  );
}

const sim = {
  source: "getCohort()",
  generator: cohort.generator,
  patients: cohort.patients.length,
  seriesLength: cohort.seriesLength,
  originMs: cohort.originMs,
  mismatched: evalBlock(cohort.eval),
  matched: {
    generator: cohort.evalMatched.generator,
    horizons: cohort.evalMatched.horizons,
    groups: cohort.evalMatched.groups,
    alerts: cohort.evalMatched.alerts,
  },
  ablation: cohort.ablation,
  streamAblation: cohort.streamAblation,
  lowCost: cohort.lowCost,
  habitLeadMin: cohort.habitLeadMin,
  habitRecall: cohort.habitRecall,
  mealResidual: cohort.mealResidual,
  leadShares: leads,
  personal: cohort.patients.map((model) => ({
    id: model.patient.id,
    name: model.patient.name,
    group: model.patient.group,
    cluster: model.patient.cluster,
    rmse60: model.fit.rmse60,
    rmse60Pop: model.fit.rmse60Pop,
    gain: Math.round((model.fit.rmse60Pop - model.fit.rmse60) * 10) / 10,
    driftStart: model.driftStart,
    driftRecovered: model.driftRecovered,
  })),
  protocols: cohort.patients.map((model) => ({
    id: model.patient.id,
    name: model.patient.name,
    plans: rankPlans(model).map((plan) => ({
      id: plan.id,
      label: plan.label,
      tirPct: plan.tirPct,
      above180Min: plan.above180Min,
      below70Min: plan.below70Min,
      meanGlucose: plan.meanGlucose,
    })),
  })),
  note: "Mismatched physiology is the stress test. Matched physiology uses the same equations as the forecaster, so it is an upper bound, not evidence the twin will transfer. Cluster shift applies only to the simulated cold-start prior. Live chart uses the five-day fit, not the incremental engine.",
};

mkdirSync(dirname(simPath), { recursive: true });
writeFileSync(simPath, `${JSON.stringify(sim, null, 2)}\n`);
console.error(`Wrote ${simPath}`);

const written = readJson(simPath);
const real = readJson(realPath);
const scale = existsSync(scalePath) ? readJson(scalePath) : null;
const proof = existsSync(proofPath) ? readJson(proofPath) : null;
const block = render(written, real, scale);
const readme = readFileSync(readmePath, "utf8");
const start = "<!-- RESULTS:START -->";
const end = "<!-- RESULTS:END -->";
const a = readme.indexOf(start);
const b = readme.indexOf(end);
if (a < 0 || b < a) throw new Error("README is missing RESULTS markers");
const next = `${readme.slice(0, a + start.length)}\n${block}\n${readme.slice(b)}`;
writeFileSync(readmePath, next);
console.error("README results block updated");
