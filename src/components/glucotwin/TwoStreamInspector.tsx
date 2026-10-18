// The two input streams of the open patient's twin: the health record as the
// FHIR R4 resources the twin reads (fhirBundle, the same bundle the tests
// check) and the wearable packet at the current minute. Each row says what
// the twin does with it.
import { useState } from "react";
import { type PatientModel } from "@/lib/glucotwin/cohort";
import { fhirBundle } from "@/lib/glucotwin/fhir";
import { postWalkSensitivity, STEP_MIN } from "@/lib/glucotwin/physics";
import { useTwinUi } from "@/lib/glucotwin/store";

type Row = { label: string; value: string; use: string };

const LAB_USE: Record<string, string> = {
  HbA1c: "Record prior: carb sensitivity, fasting level, activity effect; cluster label",
  "Fasting glucose": "Record prior: fasting level; cluster label",
  "Fasting insulin": "Record prior via HOMA-IR; cluster label",
  Triglycerides: "Listed only; not used by the twin",
  HDL: "Listed only; not used by the twin",
  LDL: "Listed only; not used by the twin",
};

type Resource = Record<string, unknown> & { resourceType: string; id: string };

function textOf(value: unknown): string {
  return value && typeof value === "object" && "text" in value && typeof value.text === "string"
    ? value.text
    : "";
}

function recordRows(model: PatientModel): Row[] {
  const rows: Row[] = [];
  let conditionShown = false;
  for (const { resource } of fhirBundle(model.patient).entry as { resource: Resource }[]) {
    if (resource.resourceType === "Patient") {
      rows.push({
        label: `Patient/${resource.id}`,
        value: `${String(resource.gender)}, born ${String(resource.birthDate)}`,
        // The simulated record formula (ehrPrior) has no age term; age acts through the MARD cluster shift.
        use: model.patient.simulated
          ? "Record prior: sex shifts carb sensitivity; age acts only through the cluster label (MARD: 60+ with HbA1c under 8.5%)"
          : "Ridge prior: age and sex, with labs and BMI",
      });
    } else if (resource.resourceType === "Condition") {
      // The real-data adapter keeps study notes after the diagnosis; only the diagnosis is a condition.
      if (conditionShown) continue;
      conditionShown = true;
      rows.push({
        label: "Condition",
        value: textOf(resource.code),
        use: "Group prior (Type 2, prediabetes or healthy)",
      });
    } else if (resource.resourceType === "Observation") {
      const name = textOf(resource.code);
      if (name === "TCF7L2 risk alleles" && !model.patient.simulated) continue;
      const quantity = resource.valueQuantity as { value?: number; unit?: string } | undefined;
      const value =
        quantity?.value != null
          ? `${quantity.value} ${quantity.unit ?? ""}`.trim()
          : typeof resource.valueInteger === "number"
            ? `${resource.valueInteger}`
            : "—";
      const use =
        name === "TCF7L2 risk alleles"
          ? "Record prior: carb sensitivity (simulated marker)"
          : (LAB_USE[name] ?? "Listed only; not used by the twin");
      rows.push({ label: `Observation · ${name}`, value, use });
    } else if (resource.resourceType === "MedicationRequest") {
      const name = textOf(resource.medicationCodeableConcept);
      const from = model.patient.sulfonylureaFromDay;
      rows.push({
        label: "MedicationRequest",
        value: name,
        use:
          from != null && /sulfonylurea/i.test(name)
            ? `Drug term: smaller meal rises and a fasting-gap fall from day ${from + 1}`
            : "Listed only; not modelled",
      });
    }
  }
  return rows;
}

function wearableRows(model: PatientModel, index: number, lagMin: number): Row[] {
  const reading = model.readings[index];
  const nowMin = index * STEP_MIN;
  const recorded = model.nights[Math.floor(nowMin / 1440)];
  const night = recorded && recorded.efficiency > 0 ? recorded : undefined;
  const walks = model.walks.filter((walk) => walk.logged && walk.min + walk.durationMin <= nowMin);
  const lastWalk = walks.at(-1);
  const lift = postWalkSensitivity(nowMin, walks);
  return [
    {
      label: "CGM, 5-min",
      value:
        reading?.glucose != null
          ? `${Math.round(reading.glucose)} mg/dL, ${lagMin} min behind the ward clock`
          : "No reading",
      use: "Anchor of the 2-hour forecast",
    },
    {
      label: "Heart rate · METs",
      value:
        reading?.worn && reading.hr != null
          ? `${reading.hr} bpm · ${reading.mets ?? "—"} METs`
          : "Watch not worn",
      use: model.patient.simulated
        ? "Shown only; logged walks drive the activity term"
        : "METs of 3 or more for 10+ min become a walk; heart rate is shown only",
    },
    {
      label: "Last night's sleep",
      value: night
        ? `${night.durationH.toFixed(1)} h · efficiency ${Math.round(night.efficiency * 100)}%`
        : "No sleep stream",
      use: "Sleep multiplier on carb sensitivity and dawn rise",
    },
    {
      label: "HRV (RMSSD)",
      value: night ? `${Math.round(night.rmssd)} ms` : "No sleep stream",
      use: "Compared with this patient's HRV baseline in the same multiplier",
    },
    {
      label: "Steps, last day",
      value: recorded?.steps != null ? recorded.steps.toLocaleString("en-IN") : "Not recorded",
      use: "Shown only",
    },
    {
      label: "Last logged walk",
      value: lastWalk
        ? `${lastWalk.durationMin} min, ended ${Math.round((nowMin - lastWalk.min - lastWalk.durationMin) / 60)} h ago`
        : "None yet",
      use: `Post-walk carb-sensitivity multiplier now ×${lift.toFixed(2)}`,
    },
  ];
}

function Table({ rows, head }: { rows: Row[]; head: [string, string, string] }) {
  return (
    <table className="mt-2 w-full border-collapse">
      <thead>
        <tr className="border-b border-line text-left">
          {head.map((cell) => (
            <th key={cell} className="py-1 pr-2 font-semibold">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={`${row.label}-${i}`} className="border-b border-line align-top last:border-b-0">
            <td className="py-1 pr-2">{row.label}</td>
            <td className="py-1 pr-2 tabular-nums">{row.value}</td>
            <td className="py-1 text-muted">{row.use}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TwoStreamInspector({
  model,
  index,
  lagMin,
}: {
  model: PatientModel;
  index: number;
  lagMin: number;
}) {
  const [open, setOpen] = useState(false);
  const consent = useTwinUi((state) => state.consent[model.patient.id]) ?? {
    ehr: true,
    wearable: true,
  };
  const knobs = model.params.knobs;
  const knobRows: Row[] = [
    {
      label: "Carb sensitivity",
      value: `${knobs.carbSensitivity.toFixed(1)} mg/dL per 10 g`,
      use: "Size of each meal's rise",
    },
    {
      label: "Activity effect",
      value: `${knobs.activityEffect.toFixed(1)} mg/dL per 30-min walk`,
      use: "Drop from a logged walk",
    },
    {
      label: "Fasting baseline",
      value: `${Math.round(knobs.fastingBaseline)} mg/dL`,
      use: "Level between meals",
    },
    { label: "Dawn rise", value: `${knobs.dawnAmp.toFixed(1)} mg/dL`, use: "Early-morning rise" },
    {
      label: "Meal time-constant",
      value: `${Math.round(knobs.tauMin)} min`,
      use: "How long a meal's rise lasts",
    },
  ];
  return (
    <section className="rounded-2xl border border-line bg-surface">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left text-sm font-semibold text-ink"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span>
          Inspect the two input streams
          <span className="ml-2 text-xs font-medium text-muted">
            FHIR R4 record + wearable packet
          </span>
        </span>
        <span aria-hidden>{open ? "−" : "+"}</span>
      </button>
      {open ? (
        <div className="grid gap-4 border-t border-line px-4 py-4 text-xs md:grid-cols-2">
          <div>
            <h3 className="text-sm font-semibold text-ink">
              Stream 1 · Health record, {model.patient.name} ({model.patient.id})
            </h3>
            <p className="mt-1 text-muted">
              {consent.ehr
                ? "The FHIR R4 resources this twin's record prior is built from. BMI also feeds the prior."
                : "Record withdrawn: the twin is not using these resources."}
            </p>
            <Table rows={recordRows(model)} head={["Resource", "Value", "Used by the twin"]} />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-ink">Stream 2 · Wearables at this minute</h3>
            <p className="mt-1 text-muted">
              {consent.wearable
                ? "Latest CGM reading, last night's sleep and the walk carry-over."
                : "Wearables withdrawn: sleep, HRV and walks are not used."}
            </p>
            <Table
              rows={wearableRows(model, index, lagMin)}
              head={["Signal", "Value", "Used by the twin"]}
            />
            <h4 className="mt-4 text-sm font-semibold text-ink">Fitted twin knobs</h4>
            <Table rows={knobRows} head={["Knob", "Value", "Effect"]} />
          </div>
        </div>
      ) : null}
    </section>
  );
}
