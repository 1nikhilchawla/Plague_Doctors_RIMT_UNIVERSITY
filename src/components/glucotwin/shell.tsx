import { Link } from "@tanstack/react-router";
import {
  Activity,
  Bell,
  FileBarChart,
  Layers,
  Moon,
  Pause,
  Play,
  Users,
  Utensils,
} from "lucide-react";
import { type ReactNode, useEffect } from "react";
import { clockMs } from "@/lib/glucotwin/cohort";
import { formatWhenIn, glucoseUnitLabel } from "@/lib/glucotwin/format";
import { getRealEval } from "@/lib/glucotwin/real/adapt";
import { useConsentedModel, useTwinUi, useWard } from "@/lib/glucotwin/store";
import {
  ClinicalSummary,
  LanguageToggle,
  PrintSummaryButton,
} from "@/components/glucotwin/summary";
import { cn } from "@/lib/utils";

const TABS = [
  { id: "cohort", label: "Cohort", icon: Users },
  { id: "twin", label: "Twin", icon: Activity },
  { id: "night", label: "Night", icon: Moon },
  { id: "alerts", label: "Alerts", icon: Bell },
  { id: "whatif", label: "What-if", icon: Utensils },
  { id: "split", label: "Split", icon: Layers },
  { id: "report", label: "Week", icon: FileBarChart },
] as const;

export function Shell({
  patientId,
  tab,
  children,
}: {
  patientId?: string;
  tab: "cohort" | "twin" | "night" | "alerts" | "whatif" | "split" | "report";
  children: ReactNode;
}) {
  const ward = useWard();
  const source = useTwinUi((state) => state.source);
  const setSource = useTwinUi((state) => state.setSource);
  const pendingSource = useTwinUi((state) => state.pendingSource);
  const unit = useTwinUi((state) => state.unit);
  const setUnit = useTwinUi((state) => state.setUnit);
  const wardIndex = useTwinUi((state) => state.wardIndex);
  const setWard = useTwinUi((state) => state.setWard);
  const playing = useTwinUi((state) => state.playing);
  const setPlaying = useTwinUi((state) => state.setPlaying);
  const focusId = useTwinUi((state) => state.focusId);
  const setFocus = useTwinUi((state) => state.setFocus);
  const hydrateAcks = useTwinUi((state) => state.hydrateAcks);
  const locale = useTwinUi((state) => state.locale);
  const setLocale = useTwinUi((state) => state.setLocale);
  const activeId = patientId ?? focusId;
  const patient = useConsentedModel(
    ward.patients.find((model) => model.patient.id === activeId) ?? ward.patients[0]!,
  );
  const zone = patient.patient.simulated ? "Asia/Kolkata" : "UTC";
  const clock = `${formatWhenIn(clockMs(patient, wardIndex), zone)} ${patient.patient.simulated ? "IST" : "shifted"}`;
  const real = getRealEval();

  useEffect(() => {
    if (patientId) setFocus(patientId);
  }, [patientId, setFocus]);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("glucotwin-acks");
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object")
        hydrateAcks(parsed as Record<string, { status: "ack" | "false"; note: string }>);
    } catch {
      /* ignore broken local notes */
    }
  }, [hydrateAcks]);

  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      const state = useTwinUi.getState();
      if (state.wardIndex >= ward.seriesLength - 1) {
        state.setPlaying(false);
        return;
      }
      state.setWard(state.wardIndex + 1);
    }, 700);
    return () => window.clearInterval(timer);
  }, [playing, ward.seriesLength]);

  const searchFor = (id: (typeof TABS)[number]["id"]) =>
    id === "cohort"
      ? { patient: undefined, tab: undefined }
      : { patient: patient.patient.id, tab: id };

  return (
    <>
      <div className="app-screen min-h-screen bg-paper text-ink">
        <header className="no-print sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3">
            <Link to="/" search={{ patient: undefined, tab: undefined }} className="min-w-0">
              <p className="font-display text-xl leading-none text-ink">GlucoTwin</p>
              <p className="hidden text-xs text-muted sm:block">Type 2 diabetes digital twin</p>
            </Link>
            <p className="hidden text-sm text-muted md:block">
              <span className="tabular-nums text-ink">{clock}</span>
            </p>
            <div className="flex w-full flex-wrap items-center gap-2 sm:ml-auto sm:w-auto">
              <div className="flex h-11 overflow-hidden rounded-full border border-line">
                {(
                  [
                    ["simulated", "Simulated"],
                    ["cgmacros", "CGMacros"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={source === id}
                    aria-busy={pendingSource === id}
                    className={cn(
                      "px-3 text-sm font-semibold",
                      source === id ? "bg-ink text-paper" : "bg-surface text-muted",
                      pendingSource === id && "animate-pulse",
                    )}
                    onClick={() => setSource(id)}
                  >
                    {pendingSource === id ? "Loading…" : label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="inline-flex h-11 items-center gap-2 rounded-full bg-teal px-4 text-sm font-semibold text-paper"
                onClick={() => setPlaying(!playing)}
              >
                {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
                {playing ? "Pause" : "Replay"}
              </button>
              {patientId ? <PrintSummaryButton /> : null}
              <LanguageToggle value={locale} onChange={setLocale} />
              <div className="flex h-11 overflow-hidden rounded-full border border-line">
                {(["mgdl", "mmol"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={cn(
                      "px-3 text-sm font-semibold",
                      unit === option ? "bg-ink text-paper" : "bg-surface text-muted",
                    )}
                    onClick={() => setUnit(option)}
                  >
                    {glucoseUnitLabel(option)}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="mx-auto flex max-w-6xl gap-2 overflow-x-auto px-4 pb-3">
            <p className="flex h-9 shrink-0 items-center text-xs font-semibold tabular-nums text-muted md:hidden">
              {clock}
            </p>
            {ward.cues.map((cue) => (
              <Link
                key={cue.id}
                to="/"
                search={{ patient: cue.patientId, tab: cue.tab ?? "twin" }}
                onClick={() => setWard(cue.index)}
                className="inline-flex h-9 shrink-0 items-center rounded-full border border-line bg-paper px-3 text-xs font-semibold whitespace-nowrap text-ink"
              >
                {cue.label}
              </Link>
            ))}
          </div>
          <p className="border-t border-line bg-amber-soft px-4 py-2 text-center text-xs font-medium text-ink">
            {source === "simulated"
              ? "Simulated cohort · seed 42 · Research prototype — not a medical device, not medical advice."
              : `CGMacros (real, ${ward.patients.length} participants) · ${real.licence} · dates shifted · Research prototype — not a medical device, not medical advice.`}
          </p>
        </header>
        <div className="mx-auto grid max-w-6xl lg:grid-cols-[13rem_minmax(0,1fr)]">
          <aside className="no-print hidden px-3 py-5 lg:block">
            <nav className="sticky top-36 flex flex-col gap-1">
              {TABS.map((item) => {
                const Icon = item.icon;
                const current = tab === item.id;
                return (
                  <Link
                    key={item.id}
                    to="/"
                    search={searchFor(item.id)}
                    className={cn(
                      "flex h-11 items-center gap-2 rounded-xl px-3 text-sm font-semibold",
                      current ? "bg-teal-soft text-teal" : "text-muted hover:bg-surface",
                    )}
                  >
                    <Icon className="size-4" />
                    {item.label}
                  </Link>
                );
              })}
            </nav>
          </aside>
          <main className="min-w-0 px-4 pt-4 pb-28 lg:pb-16">{children}</main>
        </div>
        <nav className="no-print fixed inset-x-0 bottom-0 z-20 overflow-x-auto border-t border-line bg-surface lg:hidden">
          <ul className="flex w-max min-w-full">
            {TABS.map((item) => {
              const Icon = item.icon;
              const current = tab === item.id;
              return (
                <TabLink key={item.id} current={current} search={searchFor(item.id)}>
                  <Icon className="size-5" />
                  {item.label}
                </TabLink>
              );
            })}
          </ul>
        </nav>
      </div>
      {patientId ? <ClinicalSummary model={patient} locale={locale} /> : null}
    </>
  );
}

function TabLink({
  current,
  search,
  children,
}: {
  current: boolean;
  search: {
    patient: string | undefined;
    tab: "twin" | "night" | "alerts" | "whatif" | "split" | "report" | undefined;
  };
  children: ReactNode;
}) {
  return (
    <li className="min-w-[4.5rem] flex-1">
      <Link
        to="/"
        search={search}
        className={cn(
          "flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold",
          current ? "text-teal" : "text-muted",
        )}
      >
        {children}
      </Link>
    </li>
  );
}
