/**
 * Static record as FHIR R4 resources. Java/Synthea is not used: this generator
 * is TypeScript and writes the same resource types (Patient, Condition,
 * Observation, MedicationRequest, Encounter). Latest labs are the persona's
 * labs, not invented values. Genetic marker is simulated.
 */

import type { Patient } from "./cohort.ts";

type FhirResource = Record<string, unknown> & { resourceType: string; id: string };

export function fhirBundle(patient: Patient): { resourceType: "Bundle"; type: "collection"; generator: string; entry: { resource: FhirResource }[] } {
  const id = patient.id.toLowerCase();
  const resources: FhirResource[] = [
    {
      resourceType: "Patient",
      id,
      gender: patient.sex === "F" ? "female" : "male",
      birthDate: String(2026 - patient.age),
      extension: [{ url: "simulated", valueBoolean: patient.simulated }],
    },
    {
      resourceType: "Encounter",
      id: `${id}-enc-1`,
      status: "finished",
      subject: { reference: `Patient/${id}` },
      period: { start: "2026-02-01" },
    },
  ];
  for (const diagnosis of patient.diagnoses) {
    resources.push({
      resourceType: "Condition",
      id: `${id}-cond-${resources.length}`,
      subject: { reference: `Patient/${id}` },
      code: { text: diagnosis },
      clinicalStatus: { text: "active" },
    });
  }
  const labs: { code: string; display: string; value: number | null; unit: string }[] = [
    { code: "4548-4", display: "HbA1c", value: patient.hba1c, unit: "%" },
    { code: "1558-6", display: "Fasting glucose", value: patient.fastingGlucose, unit: "mg/dL" },
    { code: "20448-7", display: "Fasting insulin", value: patient.fastingInsulin, unit: "uIU/mL" },
    { code: "2571-8", display: "Triglycerides", value: patient.triglycerides, unit: "mg/dL" },
    { code: "2085-9", display: "HDL", value: patient.hdl, unit: "mg/dL" },
    { code: "13457-7", display: "LDL", value: patient.ldl, unit: "mg/dL" },
  ];
  for (const lab of labs) {
    if (lab.value == null) continue;
    resources.push({
      resourceType: "Observation",
      id: `${id}-obs-${lab.code}`,
      status: "final",
      subject: { reference: `Patient/${id}` },
      code: { coding: [{ system: "http://loinc.org", code: lab.code, display: lab.display }], text: lab.display },
      valueQuantity: { value: lab.value, unit: lab.unit },
      note: [{ text: patient.simulated ? "Simulated lab, matched to the persona." : "From the study record." }],
    });
  }
  resources.push({
    resourceType: "Observation",
    id: `${id}-tcf7l2`,
    status: "final",
    subject: { reference: `Patient/${id}` },
    code: { text: "TCF7L2 risk alleles" },
    valueInteger: patient.alleles,
    note: [{ text: "Simulated genetic marker. Not a clinical genotype." }],
  });
  for (const med of patient.meds) {
    resources.push({
      resourceType: "MedicationRequest",
      id: `${id}-med-${resources.length}`,
      status: "active",
      intent: "order",
      subject: { reference: `Patient/${id}` },
      medicationCodeableConcept: { text: med },
      note: [{ text: "Simulated medication list. Not a dosing recommendation." }],
    });
  }
  return {
    resourceType: "Bundle",
    type: "collection",
    generator: "glucotwin-ts-fhir",
    entry: resources.map((resource) => ({ resource })),
  };
}

export function observationValue(bundle: ReturnType<typeof fhirBundle>, display: string): number | null {
  for (const entry of bundle.entry) {
    const resource = entry.resource;
    if (resource.resourceType !== "Observation") continue;
    const code = resource.code as { text?: string };
    if (code.text !== display) continue;
    const quantity = resource.valueQuantity as { value?: number } | undefined;
    if (quantity?.value != null) return quantity.value;
    if (typeof resource.valueInteger === "number") return resource.valueInteger;
  }
  return null;
}
