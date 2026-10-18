# GlucoTwin — explainer plan (18 Oct 2026)

Made with the /brag method (latent-spaces/brag, `brag-slim` workflow): story first, the real product on screen, every frame a pure function of time, stills checked before the full render, a poster baked in as frame 0, and share copy. /brag is built for 20-second launch clips; this is the same method stretched to a narrated 25-minute explainer for the challenge's demo-video item.

**What it is:** a digital twin for Type 2 diabetes that fuses a patient's FHIR health record with CGM and wearable streams and shows the doctor the next two hours.
**Who it's for:** diabetologists and primary-care doctors reviewing patients between visits; here, the challenge judges.
**What the video must cover (the brief):** relevance to the problem statement, data, architecture, approach, scalability, real-world impact.
**Most impressive real claim:** 18.3% lower 2-hour forecast error than persistence on 45 real adults (CGMacros), 95% participant-bootstrap interval 14.9–21.4%.
**Visual hook:** Ananya's real twin screen at 1:15 pm, the forecast already rising past 180 with an Urgent alert, before the spike.
**Share caption:** see share-copy.txt.

**Angle:** "See the next two hours." The doctor's foresight, explained end to end and shown on the working dashboard, with the honest numbers.
**Tone:** `polished`. Serious and restrained: one idea per scene, soft dips through paper between scenes, captions on screen.
**Visual identity:** the app's own tokens. Paper `#f4f0e6`, surface `#fffdf8`, ink `#1a2330`, muted `#5c6772`, line `#e4dccb`, teal `#0e6e6b`, amber `#9a5b16`, indigo `#3a458f`. Fraunces and Source Sans 3 (Google Fonts, as the app loads them); Noto Sans Devanagari for हिन्दी.
**Format:** 1920×1080, 30 fps, 25 min 41 s. A caption strip with the chapter name and a progress bar with chapter ticks runs along the bottom.
**Voice:** Microsoft Heera (en-IN), a Windows voice already on this machine, at 1.36× speed. Nothing was downloaded and no text left the machine. The script is in narration.txt and the timed captions are in brag.srt, so the narration can be re-recorded in a human voice later.
**Sound:** one piece. A quiet D-major pad (I–vi–IV–V, 16 s per chord) ducked under the voice, and a soft bell chime in the same key on each chapter card. Integrated loudness −16 LUFS, peak −1.6 dBFS.

## Storyboard (chapters)

| Time | Chapter | On screen |
| --- | --- | --- |
| 00:00 | Opening | Ananya's twin screen at 13:15 IST: clock, glucose 155, the forecast past 180. Then the title and the 10-point agenda. |
| 00:44 | 01 · The problem | 101 M with diabetes, 136 M with prediabetes; 36.3% / 7.7% at target; 62.3% of energy from carbohydrate; "care sees the result weeks later"; the question; brief vs GlucoTwin table. |
| 02:38 | 02 · What GlucoTwin is | Record + CGM + wearables fuse into one twin; three jobs (forecast, warn, compare plans); decision support, never a dose. |
| 03:42 | 03 · The data | The two streams; the real Two-Stream Inspector; modelled vs display-only table; CGMacros (45 adults) and the 11-patient mismatched ward; the strict day split; privacy. |
| 06:45 | 04 · Architecture | Animated flow (inputs → stream checks → consent gate → twin core → alert and plan engines → dashboard; offline Python column); the published diagram; stack; snapshot and CI. |
| 08:53 | 05 · The approach | Why physiology; meal-rise equation; walks, dawn, sleep; five knobs; cold-start prior and cluster label; trust floors; forecast and conformal band; habit prior (real alert); alert rules with Battelino 2019 / ADA; medicine term; blind selection. |
| 13:08 | 06 · The dashboard | Real screens: cohort, Ananya's twin, consent toggle (band ×1.12), alerts with reasons, Divya's Medicine low alert, seven plans and their reasons, Hindi, food editor, clinical summary, split view (unlogged snack, sensor gap), night view, CGMacros switch. |
| 18:05 | 07 · Results | CGMacros forecast bars; Clarke 99.8% and band coverage; record fusion bars; stress-test warnings; vs simple alarms; AUROC table; lows; stream ablation; split-lunch diverging bars. |
| 21:49 | 08 · Scale | 16.3 µs/reading, 61,437/s, 1.7 KB; per-million-patient compute; sharding; fingerstick fallback. |
| 23:13 | 09 · Real-world impact | Five OPD moments; change in timing; the clinic pilot; roadmap. |
| 24:28 | 10 · Limits and safety | Limits; safety guardrails and the model card. |
| 25:20 | Close | GlucoTwin · "See the next two hours." · team, mentor, challenge. |

## Notes

**Sources.** Every number is read from the project's own files as of 17 Oct 2026: `README.md`, `docs/MODEL_CARD.md`, `reports/sim_eval.json`, `reports/alert_proof.json`, `reports/scale.json`, `src/lib/glucotwin/real/real_eval.json`, and the cited papers (ICMR-INDIAB 2022, 2023, Nature Medicine 2025; Battelino et al. 2019; ADA Standards of Care).

**Honesty.**
- Low warnings are stated as they are: 7 of 17 real lows (7 of 18 alerts true) and 6 of 16 simulated (all 6 true), both chosen blind; Divya's guard catches 1 of her 10 drug lows, and the alert shown came true with only 5 minutes of lead.
- Real-data risk is called a ranking, not a calibrated probability.
- The 60-minute trend alarm's F1 (0.637) is shown level with the twin's (0.638); the claim is earlier and quieter, not better F1.
- The CGMacros low-rule grid's earlier test-day look is disclosed, as in the README.

**Data shown.** All patients on screen are simulated (seed 42) or de-identified CGMacros participants with shifted dates. No real names, identifiers or secrets appear. Screens were captured from the local dev server on 18 Oct 2026 (`work/capture.mjs`).

**To confirm:** the faculty-mentor line on the closing card (Dr. Ashish Oberoi, Department of Computer Applications, RIMT University) comes from the README; check it before uploading.
