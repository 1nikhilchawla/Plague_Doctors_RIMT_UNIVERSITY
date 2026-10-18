import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { Shell } from "@/components/glucotwin/shell";
import { AlertsView, CohortView, NightView, ReportView, SplitView, TwinView, WhatIfView } from "@/components/glucotwin/views";
import { useConsentedModel, useLoadedWard, useTwinUi } from "@/lib/glucotwin/store";

type Tab = "twin" | "night" | "alerts" | "whatif" | "split" | "report";

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>) => {
    const tab: Tab | undefined =
      search.tab === "twin" ||
      search.tab === "night" ||
      search.tab === "alerts" ||
      search.tab === "whatif" ||
      search.tab === "split" ||
      search.tab === "report"
        ? search.tab
        : undefined;
    return {
      patient: typeof search.patient === "string" ? search.patient : undefined,
      tab,
    };
  },
  component: Home,
});

function Home() {
  const ward = useLoadedWard();
  const loadError = useTwinUi((state) => state.loadError);
  useEffect(() => {
    void useTwinUi.getState().ensureWard();
  }, []);
  useEffect(() => {
    if (ward && typeof performance !== "undefined") performance.mark("glucotwin-ward-ready");
  }, [ward]);
  if (!ward) return <WardLoading error={loadError} />;
  return <Ward />;
}

/** First paint before the ward file arrives. Server and client render the same markup. */
function WardLoading({ error }: { error: string | null }) {
  return (
    <div className="app-screen min-h-screen bg-paper text-ink">
      <header className="border-b border-line bg-surface/95">
        <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3">
          <div>
            <p className="font-display text-xl leading-none text-ink">GlucoTwin</p>
            <p className="hidden text-xs text-muted sm:block">Type 2 diabetes digital twin</p>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8" aria-busy={!error}>
        {error ? (
          <p role="alert" className="rounded-2xl border border-line bg-surface p-4 text-sm">
            The ward could not load: {error}
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">Loading the simulated ward…</p>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-hidden>
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-28 animate-pulse rounded-2xl border border-line bg-surface" />
              ))}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Ward() {
  const search = Route.useSearch();
  const ward = useLoadedWard()!;
  // Every tab sees the twin the patient has consented to.
  const model = useConsentedModel(ward.patients.find((item) => item.patient.id === search.patient));
  const tab = search.tab && model ? search.tab : "cohort";
  return (
    <Shell patientId={model?.patient.id} tab={tab}>
      {tab === "cohort" || !model ? <CohortView /> : null}
      {tab === "twin" && model ? <TwinView model={model} /> : null}
      {tab === "night" && model ? <NightView model={model} /> : null}
      {tab === "alerts" && model ? <AlertsView model={model} /> : null}
      {tab === "whatif" && model ? <WhatIfView model={model} /> : null}
      {tab === "split" && model ? <SplitView model={model} /> : null}
      {tab === "report" && model ? <ReportView model={model} /> : null}
    </Shell>
  );
}
