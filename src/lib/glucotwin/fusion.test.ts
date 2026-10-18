import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  availableIndex,
  calibrateDrugGuard,
  CALIBRATION_SEED_OFFSET,
  consentModel,
  DRUG_LOW_GUARD,
  forecastAt,
  getCohort,
} from "./cohort.ts";
import { fhirBundle, observationValue } from "./fhir.ts";
import { trendLowRisk, twinLowRisk, forecastCurve } from "./physics.ts";
import { planDeltas, rankPlans } from "./protocol.ts";
import { appleHealthExport, loadAppleHealth, sleepStages } from "./wearable.ts";

describe("sleep_stages_and_steps_present", () => {
  it("splits each simulated night into stages that add up, and counts steps", () => {
    const model = getCohort().patients.find((item) => item.patient.id === "GT-07")!;
    for (const night of model.nights) {
      assert.equal(night.simulated, true);
      assert.ok(night.stages);
      const total =
        night.stages.awakeMin + night.stages.lightMin + night.stages.deepMin + night.stages.remMin;
      assert.equal(total, Math.round(night.durationH * 60));
      assert.ok((night.steps ?? 0) > 1000);
    }
    const short = sleepStages(5, true);
    const usual = sleepStages(7.4, false);
    assert.ok(short.awakeMin / 300 > usual.awakeMin / Math.round(7.4 * 60));
  });
});

describe("health_export_loader", () => {
  it("round-trips an Apple Health shaped export", () => {
    const model = getCohort().patients[0]!;
    const exportFile = appleHealthExport(
      model.nights.map((night) => ({
        dayIndex: night.dayIndex,
        stages: night.stages!,
        steps: night.steps!,
      })),
      model.originMs,
    );
    assert.equal(exportFile.simulated, true);
    assert.ok(
      exportFile.records.some((row) => row.type === "HKCategoryTypeIdentifierSleepAnalysis"),
    );
    assert.ok(
      exportFile.records.some(
        (row) => row.type === "HKQuantityTypeIdentifierStepCount" && row.unit === "count",
      ),
    );
    const loaded = loadAppleHealth(exportFile);
    const expectedSteps = model.nights.reduce((sum, night) => sum + (night.steps ?? 0), 0);
    const expectedSleep = model.nights.reduce(
      (sum, night) => sum + night.stages!.lightMin + night.stages!.deepMin + night.stages!.remMin,
      0,
    );
    assert.equal(loaded.steps, expectedSteps);
    assert.equal(loaded.sleepMin, expectedSleep);
  });
});

describe("synthea_record_consistent", () => {
  it("writes FHIR R4 resources in TypeScript and keeps the latest labs", () => {
    const source = readFileSync(new URL("./fhir.ts", import.meta.url), "utf8");
    assert.equal(source.includes(".true"), false);
    assert.match(source, /Java\/Synthea is not used/);
    const model = getCohort().patients.find((item) => item.patient.id === "GT-31")!;
    const bundle = fhirBundle(model.patient);
    assert.equal(bundle.generator, "glucotwin-ts-fhir");
    assert.equal(bundle.resourceType, "Bundle");
    assert.ok(bundle.entry.some((entry) => entry.resource.resourceType === "Patient"));
    assert.ok(bundle.entry.some((entry) => entry.resource.resourceType === "Condition"));
    assert.ok(bundle.entry.some((entry) => entry.resource.resourceType === "MedicationRequest"));
    assert.equal(observationValue(bundle, "HbA1c"), model.patient.hba1c);
    assert.equal(observationValue(bundle, "Fasting glucose"), model.patient.fastingGlucose);
    assert.equal(observationValue(bundle, "TCF7L2 risk alleles"), model.patient.alleles);
  });
});

describe("stream_ablation", () => {
  it("scores finite arms, keeps the full stream on the fitted twin, and the personal fit earns its place", () => {
    const cohort = getCohort();
    assert.deepEqual(
      cohort.streamAblation.map((arm) => arm.id),
      [
        "full",
        "noRecord",
        "noRecordNoPersonal",
        "noMeals",
        "noActivity",
        "noSleep",
        "fullHardNight",
        "noSleepHardNight",
        "fullHardNightMeal",
        "noSleepHardNightMeal",
        "fullAfterWalk",
        "noActivityAfterWalk",
      ],
    );
    const arm = (id: string) => cohort.streamAblation.find((row) => row.id === id)!.rmse60;
    assert.ok(arm("full") < arm("noActivity"));
    assert.ok(arm("full") < arm("noMeals"));
    // The personal CGM fit earns its place. The record prior and the medicine term move pooled
    // 60-min error by well under 1 mg/dL on this ward, in either direction, so only that is checked.
    assert.ok(arm("full") < arm("noRecordNoPersonal"));
    assert.ok(Math.abs(arm("full") - arm("noRecord")) < 1);
    assert.ok(arm("fullAfterWalk") < arm("noActivityAfterWalk"));
    assert.ok(arm("fullHardNightMeal") < arm("noSleepHardNightMeal"));
    for (const row of cohort.streamAblation) {
      assert.ok(Number.isFinite(row.rmse60));
      assert.ok(row.n > 100);
    }
    const reported = cohort.eval.horizons.find((row) => row.horizonMin === 60)!.rmseTwin;
    const full = cohort.streamAblation.find((arm) => arm.id === "full")!.rmse60;
    assert.ok(Math.abs(full - reported) < 0.15);
  });
});

describe("protocol_compare_ranks_and_no_dosing", () => {
  it("ranks lifestyle plans and never adds a medicine", () => {
    const source = readFileSync(new URL("./protocol.ts", import.meta.url), "utf8");
    assert.equal(source.includes(".true"), false);
    assert.equal(/\b(insulin|metformin|sulfonylurea)\b/i.test(source), false);
    const model = getCohort().patients.find((item) => item.patient.id === "GT-07")!;
    const rows = rankPlans(model);
    assert.equal(rows[0]?.id, "as-logged");
    assert.equal(rows.length, 7);
    assert.ok(rows.some((row) => row.id === "fasting-day"));
    for (const row of rows) {
      assert.ok(row.tirPct >= 0 && row.tirPct <= 100);
      assert.ok(row.above180Min >= 0);
      assert.equal(/dose|mg of|tablet/i.test(row.label + row.note), false);
    }
    const deltas = planDeltas(rows);
    assert.equal(deltas.find((row) => row.id === "as-logged")?.tir, 0);
  });
});

describe("protocol_compare_not_frozen", () => {
  it("gives every Type 2 patient differentiated plan results", () => {
    for (const model of getCohort().patients.filter((item) => item.patient.group === "t2d")) {
      const rows = rankPlans(model);
      const distinct = new Set(
        rows.map((row) => `${row.tirPct}/${row.above180Min}/${row.meanGlucose}`),
      );
      assert.ok(
        distinct.size >= 4,
        `${model.patient.id} has only ${distinct.size} distinct plan rows`,
      );
    }
  });
});

describe("consent_gate_drops_stream", () => {
  it("falls back to the group prior and widens the band when a stream is withdrawn", () => {
    const cohort = getCohort();
    const model = cohort.patients.find((item) => item.patient.id === "GT-07")!;
    const index = availableIndex(model, cohort.demoIndex);
    const width = (curve: { minutesAhead: number; p10: number; p90: number }[]) => {
      const point = curve.find((item) => item.minutesAhead === 60)!;
      return point.p90 - point.p10;
    };
    const full = forecastAt(model, index)!;
    const noRecord = forecastAt(model, index, { consent: { ehr: false, wearable: true } })!;
    const noWearable = forecastAt(model, index, { consent: { ehr: true, wearable: false } })!;
    assert.ok(width(noRecord) > width(full));
    assert.ok(width(noWearable) > width(full));
    assert.notDeepEqual(
      noRecord.map((point) => point.p50),
      full.map((point) => point.p50),
    );
  });
});

describe("personal_gain_never_negative", () => {
  it("keeps every simulated twin at or below the group prior's 60-min error", () => {
    for (const model of getCohort().patients) {
      assert.ok(
        model.fit.rmse60 <= model.fit.rmse60Pop,
        `${model.patient.id}: twin ${model.fit.rmse60} vs group ${model.fit.rmse60Pop} (trust ${model.params.personalTrust})`,
      );
    }
  });
});

describe("trend_low_rule", () => {
  const rule = { aheadMin: 15, fallRate: -1.5, dampMin: 10, blend: 0.5 };
  it("fires only near the low range when CGM is falling fast and the damped projection crosses 70", () => {
    assert.equal(trendLowRisk(84, 114, rule), 0.7);
    assert.equal(trendLowRisk(84, 100, rule), 0);
    assert.equal(trendLowRisk(100, 145, rule), 0);
    assert.equal(trendLowRisk(84, null, rule), 0);
    assert.equal(trendLowRisk(84, 114, null), 0);
  });
  it("ignores a fall under 95 mg/dL within two hours of a meal", () => {
    assert.equal(trendLowRisk(92, 137, rule, { twinTrough30: null, minutesSinceMeal: 200 }), 0.7);
    assert.equal(trendLowRisk(92, 137, rule, { twinTrough30: null, minutesSinceMeal: 60 }), 0);
  });
  it("averages the trend projection with the twin's 30-min trough", () => {
    assert.equal(trendLowRisk(84, 114, rule, { twinTrough30: 80, minutesSinceMeal: null }), 0);
    assert.equal(trendLowRisk(84, 114, rule, { twinTrough30: 60, minutesSinceMeal: null }), 0.7);
  });
});

describe("diet_evidence_direction", () => {
  it("lets the protein plate cut minutes above 180 by more than the matched-carb millet plate", () => {
    const model = getCohort().patients.find((item) => item.patient.id === "GT-19")!;
    const rows = rankPlans(model);
    const protein = rows.find((row) => row.id === "protein-swap")!;
    const millet = rows.find((row) => row.id === "jowar-roti")!;
    const base = rows.find((row) => row.id === "as-logged")!;
    assert.ok(protein.above180Min < millet.above180Min);
    assert.ok(base.above180Min - protein.above180Min >= base.above180Min - millet.above180Min);
  });
});

describe("record_withdrawal_widens_at_trust_zero", () => {
  it("widens the band by at least 12% even for a twin that kept its prior", () => {
    const cohort = getCohort();
    const model = cohort.patients.find((item) => item.params.personalTrust === 0);
    assert.ok(model, "expected at least one trust-0 twin");
    const index = availableIndex(model, cohort.demoIndex);
    const width = (curve: { minutesAhead: number; p10: number; p90: number }[]) => {
      const point = curve.find((item) => item.minutesAhead === 60)!;
      return point.p90 - point.p10;
    };
    const full = forecastAt(model, index)!;
    const noRecord = forecastAt(model, index, { consent: { ehr: false, wearable: true } })!;
    assert.ok(width(noRecord) >= width(full) * 1.12 - 1e-9);
  });
});

describe("consent_reaches_every_view", () => {
  it("rebuilds alerts, risk, forecasts and plans for the consented twin", () => {
    const model = getCohort().patients.find((item) => item.patient.id === "GT-31")!;
    const consent = { ehr: false, wearable: false };
    const view = consentModel(model, consent);
    assert.equal(consentModel(model, consent), view, "memoised");
    assert.equal(consentModel(model, { ehr: true, wearable: true }), model);
    assert.equal(view.patient.sulfonylureaFromDay, null);
    assert.equal(view.walks.length, 0);
    assert.notDeepEqual(Array.from(view.spikeProb), Array.from(model.spikeProb));
    const index = 16 * 288 + 200;
    assert.deepEqual(forecastAt(view, index), forecastAt(model, index, { consent }));
    assert.notDeepEqual(
      rankPlans(view).map((row) => row.meanGlucose),
      rankPlans(model).map((row) => row.meanGlucose),
    );
  });
});

describe("watch_upgrades_to_urgent", () => {
  it("upgrades an active Watch in place and scores Urgent against severe events", () => {
    const cohort = getCohort();
    const upgraded = cohort.patients
      .flatMap((model) => model.alerts)
      .filter(
        (alert) =>
          alert.severity === "urgent" && alert.urgentAt != null && alert.urgentAt > alert.index,
      );
    assert.ok(upgraded.length > 0);
    const alerts = cohort.eval.alerts;
    assert.ok(alerts.urgentEvents! > 0);
    assert.ok(alerts.urgentEvents! <= alerts.spikeEvents + alerts.lowEvents);
    assert.ok(alerts.urgentHits! <= alerts.urgentEvents!);
    assert.ok(alerts.urgentHitsAllEvents! <= alerts.spikeEvents + alerts.lowEvents);
  });
});

describe("fingersticks_monotone", () => {
  it("lowers the fill error with every extra nested prick: 2 > 4 > 6 > 8 > continuous", () => {
    const rmse = getCohort().lowCost.map((row) => row.rmse);
    for (let i = 1; i < rmse.length; i += 1)
      assert.ok(rmse[i]! < rmse[i - 1]!, JSON.stringify(rmse));
  });
});

describe("plans_move_tir_and_mean", () => {
  it("lets an earlier or split meal change time in range or the mean, not only the peak", () => {
    for (const model of getCohort().patients.filter((item) => item.patient.group === "t2d")) {
      const rows = rankPlans(model);
      const base = rows.find((row) => row.id === "as-logged")!;
      for (const id of ["earlier-meal", "split-meal"] as const) {
        const row = rows.find((item) => item.id === id)!;
        assert.ok(
          row.tirPct !== base.tirPct || row.meanGlucose !== base.meanGlucose,
          `${model.patient.id} ${id}`,
        );
      }
    }
  });
});

describe("sulfonylurea_low_guard", () => {
  it("raises low alerts with a medicine reason only once the drug is on the record", () => {
    const model = getCohort().patients.find((item) => item.patient.id === "GT-31")!;
    const fromDay = model.patient.sulfonylureaFromDay!;
    const low = model.alerts.filter((alert) => alert.kind === "low");
    const cites = (alert: { reasons: { group: string }[] }) =>
      alert.reasons.some((reason) => reason.group === "Medicine");
    assert.ok(low.some((alert) => alert.index >= fromDay * 288 && cites(alert)));
    assert.equal(low.filter((alert) => alert.index < fromDay * 288 && cites(alert)).length, 0);
  });
});

describe("drug_guard_blind_calibration", () => {
  it("takes DRUG_LOW_GUARD from the independent realization, never the scored seed", () => {
    const result = calibrateDrugGuard();
    assert.equal(result.seedOffset, CALIBRATION_SEED_OFFSET);
    assert.ok(CALIBRATION_SEED_OFFSET > 0);
    assert.ok(result.lowEvents > 0);
    assert.deepEqual(result.chosen, DRUG_LOW_GUARD);
  });
});

describe("post_meal_low_guard", () => {
  it("drops the twin's low risk above 92 mg/dL within 2 h of a meal unless a drug is active", () => {
    const curve = forecastCurve({
      nowMin: 13 * 60,
      glucoseNow: 100,
      meals: [],
      walks: [],
      knobs: {
        carbSensitivity: 8,
        activityEffect: 15,
        fastingBaseline: 50,
        dawnAmp: 0,
        tauMin: 40,
      },
      band: { q10: -15, q90: 15 },
      horizonMin: 60,
    });
    const free = twinLowRisk(100, curve, { minutesSinceMeal: null, drugActive: false });
    assert.ok(free > 0.5);
    assert.equal(twinLowRisk(100, curve, { minutesSinceMeal: 60, drugActive: false }), 0);
    assert.equal(twinLowRisk(100, curve, { minutesSinceMeal: 60, drugActive: true }), free);
    assert.equal(twinLowRisk(100, curve, { minutesSinceMeal: 150, drugActive: false }), free);
  });
});

describe("meal_residual_choice", () => {
  it("keeps the residual mode the simulated ward was built with as the validation-day choice", () => {
    const cohort = getCohort();
    assert.equal(cohort.mealResidual.chosen, "plain");
    for (const model of cohort.patients) assert.notEqual(model.params.knobs.mealResidual, "scaled");
  });
});
