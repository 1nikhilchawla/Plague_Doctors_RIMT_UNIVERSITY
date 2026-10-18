/**
 * Approximate INSPIRED-style labels. Not the published clustering method.
 * The published study used C-peptide, GAD antibodies and a data-driven
 * partition we do not have. This is a documented decision list on the labs
 * that are actually on the record. See docs/CLUSTERS.md.
 */

import { homaIr, type TwinKnobs } from "./physics.ts";

export type ClusterId = "SIDD" | "IROD" | "CIRDD" | "MARD" | "none";

export type ClusterRecord = {
  hba1c: number;
  bmi: number;
  age: number;
  fastingGlucose: number | null;
  fastingInsulin: number | null;
  triglycerides?: number | null;
  hdl?: number | null;
};

export type ClusterAssignment = {
  id: ClusterId;
  /** Always true: this is not the published INSPIRED partition. */
  approximate: true;
  note: string;
  homaIr: number | null;
  homaB: number | null;
  /** Record fields that decided the label, in the order the rule used them. */
  fields: string[];
};

/** HOMA-B % = 360 × fasting insulin / (fasting glucose − 63). Undefined at or below 63 mg/dL. */
export function homaB(glucose: number | null, insulin: number | null): number | null {
  if (glucose == null || insulin == null || glucose <= 63 || insulin <= 0) return null;
  return (360 * insulin) / (glucose - 63);
}

/**
 * First match wins.
 * CIRDD: high HbA1c and clear insulin resistance with a limited beta-cell index.
 * SIDD: lean, high HbA1c, low HOMA-B, resistance not in the CIRDD range.
 * MARD: age 60 or older and HbA1c under 8.5, after the severe labels.
 * IROD: BMI at least 25 with HOMA-IR at least 2.5.
 * Below 6.5% HbA1c we do not force a type 2 cluster.
 */
export function assignCluster(record: ClusterRecord): ClusterAssignment {
  const ir =
    record.fastingGlucose == null || record.fastingInsulin == null
      ? null
      : homaIr(record.fastingGlucose, record.fastingInsulin);
  const beta = homaB(record.fastingGlucose, record.fastingInsulin);
  const fields = [
    `HbA1c ${record.hba1c}%`,
    `BMI ${record.bmi}`,
    `age ${record.age}`,
    ir == null ? "HOMA-IR missing" : `HOMA-IR ${ir.toFixed(2)}`,
    beta == null ? "HOMA-B missing" : `HOMA-B ${beta.toFixed(1)}`,
  ];
  if (record.triglycerides != null) fields.push(`triglycerides ${record.triglycerides} mg/dL`);
  if (record.hdl != null) fields.push(`HDL ${record.hdl} mg/dL`);
  const base = { approximate: true as const, homaIr: ir, homaB: beta, fields };

  if (record.hba1c < 6.5) {
    return {
      ...base,
      id: "none",
      note:
        record.hba1c < 5.7
          ? "HbA1c is under 5.7%. No type 2 cluster is assigned."
          : "HbA1c is in the prediabetes range. This rule does not force a type 2 cluster.",
    };
  }
  if (record.hba1c >= 8.5 && ir != null && ir >= 4 && beta != null && beta < 100) {
    return {
      ...base,
      id: "CIRDD",
      note: "Approximate CIRDD: HbA1c at least 8.5%, HOMA-IR at least 4, HOMA-B under 100. Not the published method.",
    };
  }
  if (record.bmi < 25 && record.hba1c >= 7.5 && (beta == null || beta < 50) && (ir == null || ir < 4)) {
    return {
      ...base,
      id: "SIDD",
      note: "Approximate SIDD: BMI under 25, HbA1c at least 7.5%, HOMA-B under 50, HOMA-IR under 4. Not the published method.",
    };
  }
  if (record.age >= 60 && record.hba1c < 8.5) {
    return {
      ...base,
      id: "MARD",
      note: "Approximate MARD: age 60 or older and HbA1c under 8.5%, after the severe labels. Not the published method.",
    };
  }
  if (record.bmi >= 25 && ir != null && ir >= 2.5) {
    return {
      ...base,
      id: "IROD",
      note: "Approximate IROD: BMI at least 25 and HOMA-IR at least 2.5. Not the published method.",
    };
  }
  return {
    ...base,
    id: record.age >= 50 ? "MARD" : "IROD",
    note: "Fallback approximate label because the labs missed the earlier rules. Not the published method.",
  };
}

/** Modelling assumption. Added only to the cold-start record prior, then clipped. Not a published effect size. */
const SHIFT: Record<ClusterId, TwinKnobs> = {
  SIDD: { carbSensitivity: 2.5, activityEffect: -2, fastingBaseline: 6, dawnAmp: 2, tauMin: 15 },
  IROD: { carbSensitivity: 0.8, activityEffect: -3, fastingBaseline: 4, dawnAmp: 1, tauMin: 20 },
  CIRDD: { carbSensitivity: 3, activityEffect: -2, fastingBaseline: 10, dawnAmp: 4, tauMin: 25 },
  MARD: { carbSensitivity: -0.8, activityEffect: 1, fastingBaseline: -4, dawnAmp: -2, tauMin: -10 },
  none: { carbSensitivity: 0, activityEffect: 0, fastingBaseline: 0, dawnAmp: 0, tauMin: 0 },
};

function clip(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

export function applyCluster(knobs: TwinKnobs, cluster: ClusterId): TwinKnobs {
  const shift = SHIFT[cluster];
  return {
    carbSensitivity: clip(knobs.carbSensitivity + shift.carbSensitivity, 0.5, 40),
    activityEffect: clip(knobs.activityEffect + shift.activityEffect, 0, 80),
    fastingBaseline: clip(knobs.fastingBaseline + shift.fastingBaseline, 70, 220),
    dawnAmp: clip(knobs.dawnAmp + shift.dawnAmp, 0, 40),
    tauMin: clip(knobs.tauMin + shift.tauMin, 40, 240),
  };
}

export function clusterShift(cluster: ClusterId): TwinKnobs {
  return { ...SHIFT[cluster] };
}
