# Hazards

Research prototype — not a medical device, not medical advice. Each row names a test that locks the mitigation. If a mitigation is only a label, the test says so.

| Hazard | Cause | Effect | Mitigation in code | Test |
|---|---|---|---|---|
| Missed spike or low | Threshold, suppression, or a gap | No alert before the event | Event scoring with a hit window before the event; lows outrank spikes | `event scoring` in `logic.test.ts` |
| False alert / fatigue | A noisy probability fires all day | Alert load the clinician ignores | Hygiene: fire at 0.6, clear at 0.4, 60 min suppression, 8 alerts a day | `alert hygiene` in `logic.test.ts` |
| Stale stream | Wearable lag | Forecast treated as live | Forecast pauses when the lag is over 15 min | `beats persistence` checks Suresh is stale |
| Sensor gap | Dropout | A number invented across the hole | Gap blocks the forecast and the split | `refuses to split a sensor gap` |
| Compression low | Pressure on the sensor | A false hypoglycaemia | Compression minutes are excluded from lows and from the twin | `event scoring` ignores a gap; compression flagged on Ananya |
| Unit confusion | mg/dL read as mmol/L | A ten-fold error | Axis label and a toggle; thresholds converted | `converts mmol/L` and chart ticks |
| Wrong record | Labs from another person | A prior that is not theirs | Record card shows the fields that set the cluster; ridge is leave-one-out | `cluster_assignment`, `ehr_prior_ablation_runs` |
| Invented clinical number | A sentence adds a figure | A false HbA1c or dose | Clinical note rejects numbers that are not in the inputs | `rejects a note that invents a number` |
| Consent revoked mid-stream | A stream is turned off but still used | Activity, sleep or record data the person withdrew | Per-stream toggles on the Twin screen. Withdrawing the record drops the record prior and the medication list; the twin keeps its personal CGM fit, shrunk toward the group prior, and the band widens at least ×1.12. Withdrawing wearables drops sleep, HRV and walks (band ×1.1). Alerts, plans and the ward ranking follow the consented twin. Consent lives in the browser session only: there is no consent store and no ABDM consent artefact. | `consent_gate_drops_stream` in src/lib/glucotwin/fusion.test.ts |
| Drift | Physiology changes after the fit | A confident curve that is wrong | 12 h outside the band, held for 6 h, sets "Twin out of sync". The on-screen fit is not silently replaced. | `drift_detected_and_recovered` |
| Drug change missed | A new tablet on day 16 | Carb effect falls 30% and fasting-gap lows begin | The twin reads the sulfonylurea from the record: from day 16 it scales meal rises ×0.75, expects a fall during long gaps, and a low guard projects the rest of that fall from 15:00 to 06:00. Lows after an unlogged snack stay invisible to it. The drift chip still flags a start on or after that day. | `sulfonylurea_low_guard`, `drift_detected_and_recovered` |
| Cluster over-read | The label is treated as INSPIRED | A wrong phenotype | The card says approximate, and `docs/CLUSTERS.md` lists the missing inputs | `cluster_assignment` |
| What-if read as advice | A meal simulation | A dosing decision | Caption "Simulation, not advice" | Shown on the what-if sheet |
