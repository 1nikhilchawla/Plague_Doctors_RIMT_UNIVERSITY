import { create } from "zustand";
import {
  consentModel,
  simWardFromSnapshot,
  type PatientModel,
  type SimWardSnapshot,
  type StreamConsent,
} from "./cohort.ts";
import type { Locale } from "./i18n.ts";
import type { Ward } from "./real/adapt.ts";

export type Ack = { status: "ack" | "false"; note: string };
export type CohortSource = "simulated" | "cgmacros";

type UiState = {
  unit: "mgdl" | "mmol";
  /** Language of the What-if plan table and the printed summary. */
  locale: Locale;
  source: CohortSource;
  /** Wards loaded so far. The active one is `wards[source]`; null until its file arrives. */
  wards: Partial<Record<CohortSource, Ward>>;
  /** A source switch waiting for its ward to load. */
  pendingSource: CohortSource | null;
  loadError: string | null;
  wardIndex: number;
  playing: boolean;
  focusId: string;
  acks: Record<string, Ack>;
  plans: Record<string, string>;
  /** Per-patient stream consent (DPDP-style). Missing means both streams allowed. */
  consent: Record<string, StreamConsent>;
  setUnit: (unit: "mgdl" | "mmol") => void;
  setLocale: (locale: Locale) => void;
  setSource: (source: CohortSource) => void;
  /** Loads the active source's ward (first paint shows a placeholder until it arrives). */
  ensureWard: () => Promise<void>;
  setWard: (index: number) => void;
  setPlaying: (playing: boolean) => void;
  setFocus: (id: string) => void;
  acknowledge: (id: string, status: "ack" | "false", note: string) => void;
  choosePlan: (patientId: string, planId: string) => void;
  setConsent: (patientId: string, stream: keyof StreamConsent, allowed: boolean) => void;
  hydrateAcks: (acks: Record<string, Ack>) => void;
};

const inflight: Partial<Record<CohortSource, Promise<Ward>>> = {};

/**
 * Each ward loads on first use. The simulated ward comes from a committed
 * snapshot of the fitted twins (rebuilt and checked by `npm test`), so the app
 * never runs the ~3 s fit or the cohort evaluation in the browser. CGMacros
 * loads its three participants' series file only when that source is chosen.
 */
function isSimWardSnapshot(value: unknown): value is SimWardSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "patients" in value &&
    Array.isArray(value.patients)
  );
}

export function loadWard(source: CohortSource): Promise<Ward> {
  inflight[source] ??=
    source === "cgmacros"
      ? import("./real/adapt.ts").then((module) =>
          module.loadRealCohort(() => import("./real/demo_patients.json").then((file) => file.default)),
        )
      : import("./ward_snapshot.json").then((file) => {
          // Marks for the load-time check in docs/CHANGELOG_EVAL.md (snapshot arrived, ward rebuilt).
          performance.mark("glucotwin-snapshot-loaded");
          const snapshot: unknown = file.default;
          if (!isSimWardSnapshot(snapshot)) throw new Error("ward_snapshot.json is not a version 1 SimWardSnapshot");
          const ward = simWardFromSnapshot(snapshot);
          performance.mark("glucotwin-ward-hydrated");
          return {
            patients: ward.patients,
            seriesLength: ward.seriesLength,
            demoIndex: ward.demoIndex,
            cues: ward.cues,
            trainingMaxCarbs: ward.trainingMaxCarbs,
            source: "simulated" as const,
          };
        });
  return inflight[source]!;
}

export const useTwinUi = create<UiState>((set, get) => ({
  unit: "mgdl",
  locale: "en",
  source: "simulated",
  wards: {},
  pendingSource: null,
  loadError: null,
  wardIndex: 0,
  playing: false,
  focusId: "GT-07",
  acks: {},
  plans: {},
  consent: {},
  setUnit: (unit) => set({ unit }),
  setLocale: (locale) => set({ locale }),
  setSource: (source) => {
    set({ pendingSource: source, playing: false, loadError: null });
    loadWard(source).then(
      (ward) => {
        // A later click wins.
        if (get().pendingSource !== source) return;
        set((state) => ({
          wards: { ...state.wards, [source]: ward },
          source,
          pendingSource: null,
          wardIndex: ward.demoIndex,
          focusId: ward.patients[0]?.patient.id ?? "",
        }));
      },
      (error: unknown) => set({ pendingSource: null, loadError: String(error) }),
    );
  },
  ensureWard: async () => {
    const { source, wards } = get();
    if (wards[source]) return;
    try {
      const ward = await loadWard(source);
      set((state) => ({
        wards: { ...state.wards, [source]: ward },
        wardIndex: state.wards[source] ? state.wardIndex : ward.demoIndex,
      }));
    } catch (error) {
      set({ loadError: String(error) });
    }
  },
  setWard: (wardIndex) =>
    set((state) => {
      const last = (state.wards[state.source]?.seriesLength ?? 1) - 1;
      return { wardIndex: Math.max(0, Math.min(last, Math.round(wardIndex))) };
    }),
  setPlaying: (playing) => set({ playing }),
  setFocus: (focusId) => set({ focusId }),
  acknowledge: (id, status, note) =>
    set((state) => {
      const acks = { ...state.acks, [id]: { status, note } };
      if (typeof window !== "undefined") {
        window.localStorage.setItem("glucotwin-acks", JSON.stringify(acks));
      }
      return { acks };
    }),
  choosePlan: (patientId, planId) =>
    set((state) => ({ plans: { ...state.plans, [patientId]: planId } })),
  setConsent: (patientId, stream, allowed) =>
    set((state) => {
      const current = state.consent[patientId] ?? { ehr: true, wearable: true };
      return { consent: { ...state.consent, [patientId]: { ...current, [stream]: allowed } } };
    }),
  hydrateAcks: (acks) => set({ acks }),
}));

/** The active ward. Only for components rendered after the ward has loaded (see routes/index.tsx). */
export function useWard(): Ward {
  const ward = useTwinUi((state) => state.wards[state.source]);
  if (!ward) throw new Error("The ward has not loaded yet.");
  return ward;
}

/**
 * The patient under their stream consent: the same object while both streams
 * are shared, otherwise the memoised consented twin from cohort.ts.
 */
export function useConsentedModel<T extends PatientModel | undefined>(model: T): T {
  const consent = useTwinUi((state) => (model ? state.consent[model.patient.id] : undefined));
  return (model ? consentModel(model, consent) : model) as T;
}

/** The active ward, or null while its file is still loading. */
export function useLoadedWard(): Ward | null {
  return useTwinUi((state) => state.wards[state.source] ?? null);
}
