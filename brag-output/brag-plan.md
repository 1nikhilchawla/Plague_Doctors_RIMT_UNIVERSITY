# GlucoTwin — brag plan (v2, 18 Oct 2026)

**What it is:** a digital twin for Type 2 diabetes that fuses a patient's health record with their CGM and wearable streams and shows the doctor the next two hours of glucose.
**Who it's for:** diabetologists reviewing patients between visits.
**What sets it apart:** it forecasts, warns before spikes and lows with reasons, reads the medication list, respects per-stream consent, and tests lifestyle plans on each patient's own twin. The same plan can help one patient and hurt another.
**Most impressive claim (real):** 18.3% lower 2-hour forecast error than persistence on 45 real adults (CGMacros, PhysioNet); the twin beats persistence at 30, 60 and 120 minutes.
**Visual hook:** Ananya's real twin chart drawing in, then the dashed forecast shooting past the 180 line: the spike seen before it happens.
**Share caption:** see share-copy.txt.

**What changed from v1 (16 Oct):**
- The low-alert scene no longer claims "11 of 16 lows, 92% precise". That figure came from a drug guard tuned on the scored lows and was withdrawn on 17 Oct. The scene now leads with what the twin does ("It reads the medicine list") and states the blind result: 6 of 16 simulated lows warned, all 6 alerts came true.
- A new scene shows the product in use: a cursor clicks the real "Health record (FHIR R4)" consent toggle, the record is withdrawn, and the band visibly widens (×1.12).
- Context moved into kickers ("stress test"), and footnotes were shortened so every line can be read in the time it is on screen.

**Angle:** "See the next two hours." The doctor's moment of foresight, shown with the real dashboard.
**Tone:** `polished`. Serious and restrained, with soft fades and dips through paper.
**Visual identity:** the app's own tokens.
- Colours: paper `#f4f0e6`, surface `#fffdf8`, ink `#1a2330`, muted `#5c6772`, line `#e4dccb`, teal `#0e6e6b`, amber `#9a5b16` (consent), indigo `#3a458f` (low alerts).
- Fonts: Fraunces and Source Sans 3, from Google Fonts as the app loads them.
**Format:** 1920×1080, 30 fps, 25.0 s. Eight scenes on the 96 BPM beat grid (0.625 s, 40 beats). Frame 0 is the poster (the settled forecast scene), replacing the first frame so timing and sync are unchanged.

## Storyboard

| # | Time (s) | Scene | On screen |
|---|---|---|---|
| 1 | 0.000–3.750 | Hook | "16 Mar · 1:15 pm · simulated patient". "Ananya just ate lunch." The real twin chart wipes in, the forecast and band rise past 180, and a pulse marks the predicted peak. "Her twin already sees the spike." |
| 2 | 3.750–6.250 | Reveal | "GlucoTwin" · "A digital twin for Type 2 diabetes." · "Health record + CGM + wearables" |
| 3 | 6.250–10.000 | Forecast | "18.3%" · "lower 2-hour error than persistence" · "45 real adults · CGMacros, PhysioNet". Bars at 30 min / 1 hour / 2 hours (18.5 vs 19.6, 26.2 vs 28.9, 31.8 vs 38.9) with their gains. |
| 4 | 10.000–13.125 | Spike alerts | "Spike alerts · stress test" · "105 min" · "median warning before a spike, with reasons". Ananya's real alert badge and three reason lines. "109 of 254 spikes warned an hour or more ahead" |
| 5 | 13.125–16.250 | Medicine | "Low alerts · stress test" · "It reads the medicine list." Divya's real low alert: badge, the Medicine reason (marked), recent glucose. "6 of 16 simulated lows warned · all 6 alerts came true" |
| 6 | 16.250–19.375 | Consent (new) | "Per-stream consent · DPDP-style" · "Withdraw the record. The twin adapts." The real chart and consent panel; a cursor clicks "Health record (FHIR R4)", it turns to withdrawn, the amber note appears and the band widens; a gentle push-in. |
| 7 | 19.375–22.500 | What-if | "Same plan. Different twins." Split-lunch bars: Vikram +3.6, Kavita +2.9, Fatima −4.1, Leela −5.4. "Helps 4 of 8 Type 2 twins, hurts 4 · never a dose" |
| 8 | 22.500–25.000 | Outro | Faded cohort screen. "GlucoTwin" · "See the next two hours." · "Happiest Health Digital Twin Challenge 2026 · Research prototype, not medical advice" |

## Notes

**Sources.** Every number comes from the project's regenerated results of 17 Oct 2026.
- `src/lib/glucotwin/real/real_eval.json`: forecast horizons.
- `reports/sim_eval.json`: spike lead and lead shares, low alerts (6 of 16, precision 1.0), split-lunch plan rows.
- The consent ×1.12 widening is the app's own on-screen text.

**Honesty.**
- Lows are reported blind and in full: 6 of 16 warned (recall shown, not only precision).
- Alert "Probability" labels are cropped out because the risk display is not calibrated on real data; the low card's outcome line ("lead 5 min") is not shown, and no low lead time is claimed.

**Data shown.** All patients on screen are simulated (seed 42). No real names, identifiers or secrets appear. Screens were captured from the local dev server (Ananya's chart and spike card on 16 Oct; Divya's low card, the consent panel and the cohort on 18 Oct, same ward and clock).

**Sound.** The same piece as v1, re-cut to the new scene grid.
- Soft piano-pad progression in D major at 96 BPM (D – Bm – G – A ×2, then G – D), a quiet pulse from the reveal on, air whooshes on every cut.
- An A5 bell at the predicted peak, a D6 bell when the spike alert lands, a softer F#5 for the low alert, and a short UI click with a soft A5 on the consent toggle.
- Everything sits under one light reverb.
