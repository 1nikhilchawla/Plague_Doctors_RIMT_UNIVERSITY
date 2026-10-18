import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { applyCluster, assignCluster, homaB } from "./clusters.ts";
import { getCohort } from "./cohort.ts";
import { seededEhrPrior } from "./ehr.ts";

const EXPECTED: Record<string, string> = {
  "GT-07": "IROD",
  "GT-12": "MARD",
  "GT-03": "MARD",
  "GT-19": "CIRDD",
  "GT-21": "IROD",
  "GT-05": "none",
  "GT-28": "none",
  "GT-02": "none",
  "GT-31": "SIDD",
  "GT-33": "SIDD",
  "GT-36": "CIRDD",
};

describe("cluster_assignment", () => {
  it("labels the cohort with the documented rule and does not read the hidden generator", () => {
    const source = readFileSync(new URL("./clusters.ts", import.meta.url), "utf8");
    assert.equal(source.includes(".true"), false);
    assert.equal(homaB(63, 10), null);
    const cohort = getCohort();
    const counts: Record<string, number> = {};
    for (const model of cohort.patients) {
      const again = assignCluster({
        hba1c: model.patient.hba1c,
        bmi: model.patient.bmi,
        age: model.patient.age,
        fastingGlucose: model.patient.fastingGlucose,
        fastingInsulin: model.patient.fastingInsulin,
        triglycerides: model.patient.triglycerides,
        hdl: model.patient.hdl,
      });
      assert.equal(model.patient.cluster, EXPECTED[model.patient.id]);
      assert.equal(again.id, model.patient.cluster);
      assert.equal(again.approximate, true);
      counts[model.patient.cluster] = (counts[model.patient.cluster] ?? 0) + 1;
      if (model.patient.cluster !== "none") {
        const plain = seededEhrPrior(
          {
            hba1c: model.patient.hba1c,
            fastingGlucose: model.patient.fastingGlucose,
            fastingInsulin: model.patient.fastingInsulin,
            homaIr: model.patient.homaIr,
            bmi: model.patient.bmi,
            age: model.patient.age,
            sex: model.patient.sex,
          },
          1,
        );
        const shifted = applyCluster(plain, model.patient.cluster);
        assert.ok(shifted.carbSensitivity >= 0.5 && shifted.carbSensitivity <= 40);
        assert.ok(shifted.fastingBaseline >= 70 && shifted.fastingBaseline <= 220);
      }
    }
    for (const id of ["SIDD", "IROD", "CIRDD", "MARD"]) assert.ok((counts[id] ?? 0) >= 2);
    const divya = cohort.patients.find((model) => model.patient.id === "GT-31")!;
    assert.ok(divya.patient.meds.some((med) => med.includes("Sulfonylurea")));
    assert.equal(divya.patient.diagnoses.includes("Type 2 diabetes mellitus"), true);
  });
});

describe("alert_tiers", () => {
  it("counts urgent separately and treats every low as urgent", () => {
    const alerts = getCohort().eval.alerts;
    assert.equal(typeof alerts.urgentAlerts, "number");
    assert.ok((alerts.urgentAlerts ?? 0) <= alerts.spikeAlerts + alerts.lowAlerts);
    assert.ok((alerts.watchAlerts ?? 0) >= 0);
    assert.ok(alerts.urgentPerPatientDay != null && alerts.watchPerPatientDay != null);
    for (const model of getCohort().patients) {
      for (const alert of model.alerts) {
        assert.ok(alert.severity === "urgent" || alert.severity === "watch");
        if (alert.kind === "low") assert.equal(alert.severity, "urgent");
      }
    }
  });
});
