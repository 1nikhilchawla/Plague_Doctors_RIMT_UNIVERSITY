# GlucoTwin model card

Research prototype — not a medical device, not medical advice. All patient data is synthetic or open.

Written 17 October 2026 from the code and the committed result files (`reports/sim_eval.json`, `reports/alert_proof.json`, `reports/drug_guard_calibration.json`, `src/lib/glucotwin/real/real_eval.json`). Days are numbered from 1.

## 1. What the model is

A per-patient physiological digital twin for adults with type 2 diabetes or prediabetes. It joins a health record (FHIR R4) with CGM and wearable streams, forecasts glucose 30, 60 and 120 minutes ahead with a 10–90% band, raises spike and low alerts with reasons, and ranks seven lifestyle plans on the patient's own fitted twin.

| Item | Value |
| --- | --- |
| Model type | Mechanistic meal / walk / dawn model with five personal knobs, a decaying residual and a split-conformal band. No neural network on the live path. |
| Live code | `src/lib/glucotwin/physics.ts` (curve, risks), `cohort.ts` (fit, alerts, medicine term), `protocol.ts` (plans), `ehr.ts` and `clusters.ts` (record prior) |
| Offline code | `ml/evaluate_cgmacros.py` (CGMacros evaluation), `ml/physics.py` (Python mirror, checked by `npm run parity`: 15 functions × 20 cases within 1e-6) |
| Offline comparison only | LightGBM residual on CGMacros (three held-out people). It is not added to the live curve. |
| Version | Repository state of 17 October 2026 |
| Licence | MIT (code). CGMacros derivatives CC BY-NC-SA 4.0. See section 9. |

## 2. Intended use

- **Users:** a diabetologist or primary-care doctor reviewing a patient between visits.
- **Use:** see the next two hours of glucose with its uncertainty, see warnings before a spike or a low with the reasons on the curve, and compare lifestyle plans on that patient's twin before talking to the patient.
- **Setting:** research and demonstration on a simulated ward and on the open CGMacros dataset.

**Out of scope:** medicine dosing, diagnosis, any decision without a clinician, insulin-treated patients, type 1 diabetes, pregnancy, children, closed-loop control, and use as a replacement for a CGM's own alarms. The plan table is labelled "Simulation, not advice".

## 3. Data and population

| Data | Who | Size | Days | Notes |
| --- | --- | --- | --- | --- |
| CGMacros (PhysioNet, [doi:10.13026/3z8q-x658](https://doi.org/10.13026/3z8q-x658)) | 45 US adults (Santa Barbara): 14 type 2, 16 prediabetes, 15 healthy | 263 test patient-days | Fit 1–4, validation 5–6, test from day 7 | Dexcom primary, Libre fills gaps. Meals with macros, watch METs. No sleep or HRV stream. |
| Simulated mismatched ward | 11 synthetic personas (8 type 2, 2 prediabetes, 1 healthy), Indian names and diets | 132 test patient-days | Fit 1–5, validation 6–9, test 10–21; plans 10–16 | Seed 42. Generator shapes differ from the twin's (time-of-day factor, walk carry-over, drug step). One persona (GT-31) starts a sulfonylurea on day 16. |
| Simulated matched ward | Same personas | Same | Same | Shares the twin's equations. An upper bound, not a transfer result. |
| Drug-guard calibration realization | Same personas, every seed + 1000 | GT-31 days 16–21 (11 drug lows) | — | Used only to choose `DRUG_LOW_GUARD`; never scored. |

CGMacros is a US cohort. Results may not transfer to Indian patients, whose diets (62.3% of energy from carbohydrate in ICMR-INDIAB) and body composition differ.

## 4. Equations

All glucose values are mg/dL; times are minutes; h is the hour of day.

**Meal rise.** For a meal of C g carbohydrate with fibre fraction f (capped at 0.45), eaten d minutes ago (0 ≤ d < 180):

- peak time p = 45 + 50·f; shape s(d) = d/p up to the peak, then (180 − d)/(180 − p)
- rise = (k_c · C/10) · (1 − 0.35·f) · s(d) · M(h) · (1 + 0.003·max(0, C − 40))
- k_c is the personal carb sensitivity (mg/dL per 10 g). M(h) = 1 + 0.14·sin(2π(h − 14)/24) + 0.10·sin(π(h − 4)/5) for 4 ≤ h ≤ 9 (the meal clock). On CGMacros, validation days switched the meal clock and size factor off.

**Walk.** A walk of D minutes lowers glucose by k_a·D/30 (k_a, the personal activity effect per 30 minutes), reached linearly over the walk, held 15 minutes, recovered over 60. Afterwards carb sensitivity is multiplied by 1 − 0.28·(1 − elapsed/span), span = min(30, 12 + D/4) hours.

**Baseline.** b(t) = F + A·sin(π(h − 4)/5) (only for 4 ≤ h ≤ 9) + 3.5·sin(2π(h − 9)/24), with F the fasting baseline and A the dawn amplitude.

**Forecast.** ŷ(t + Δ) = b(t + Δ) + meals(t + Δ) + walks(t + Δ) + r·exp(−Δ / max(30, τ)), where r = y(t) − b(t) − meals(t) − walks(t) is the current residual and τ the meal time-constant. On CGMacros a negative residual during an active meal scales that meal's remaining curve instead (`mealResidual`, chosen on validation days), and a leave-one-participant-out linear trend correction is added.

**Band.** Split-conformal: the lower edge is order statistic ⌊(n + 1)·0.1⌋ and the upper ⌈(n + 1)·0.9⌉ of the n validation residuals per horizon, widening linearly over the first 30 minutes.

**Wearables.** From last night (plus half of the night before): debt = min(4, max(0, 7 − sleep hours)); poorEff = min(0.3, max(0, 0.9 − efficiency)); hrvDrop = min(0.5, max(0, (baseline − RMSSD)/baseline)). Carb sensitivity × (1 + 0.08·debt + 0.4·poorEff + 0.4·hrvDrop); dawn amplitude × (1 + 0.12·debt + 0.5·hrvDrop). Sizes are modelling assumptions at the upper end of published sleep-restriction studies. Heart rate, steps and sleep stages are displayed, not modelled.

**Record prior (simulated).** k_c = 3.1 + 1.35(HbA1c − 5) + 0.08·max(0, HOMA-IR − 1) + 0.4·[female] + 0.35·alleles; F = 0.72·FPG + 0.28·(70 + 11(HbA1c − 5)); k_a = 24 − 1.1(HbA1c − 5) − 0.15(BMI − 22); dawn and τ from the HbA1c group. An approximate cluster shift is added (SIDD / IROD / CIRDD / MARD, [CLUSTERS.md](CLUSTERS.md), not the published INSPIRED method). Age has no term of its own: it acts through the MARD label (60 or older with HbA1c under 8.5%). The live twin blends this prior with the group prior by inverse error variance and shrinks the day 1–5 personal fit toward it; one-standard-error floors on validation days fall back to the prior, and then to the group prior.

**Record prior (CGMacros).** Leave-one-out ridge on HbA1c, fasting glucose, fasting insulin, HOMA-IR, BMI, age and sex.

**Medicine term (simulated).** With a sulfonylurea on the record: meal rises × 0.75, and glucose falls once the gap since the last meal passes 180 minutes from 15:00 to 23:00 (to −48 by 260 minutes) or 300 minutes overnight (to −35). Written from the generator's documented step (−55 / −40, × 0.7) and sulfonylurea pharmacodynamics; not fitted to any day.

**Risks.** Spike risk = max(P(peak > 180), P(peak > now + 50)) over the next 120 minutes, normal approximation with σ = max(6, band width / 2.563), with the person's habitual next meal from the fitting days on the curve. Low risk = P(trough < 70) over the next 60 minutes, off above 92 mg/dL within 2 hours of a meal of 15 g or more unless a drug is active. On CGMacros a guarded CGM trend rule adds a fixed 0.7 risk; on the simulated ward the drug low guard shifts the curve down by the rest of the expected fall.

**Plan gain.** gain = ΔTIR − Δ(min > 180)/14.4 − w·Δ(min < 70)/14.4 − Δmean/50, with w = 3, or 6 when the record lists a glucose-lowering drug or the as-logged week has lows. A clinical weighting choice, not fitted.

## 5. Thresholds and their sources

| Threshold | Value | Source |
| --- | --- | --- |
| Low | < 70 mg/dL | International Consensus on Time in Range (Battelino et al., Diabetes Care 2019, [doi:10.2337/dci19-0028](https://doi.org/10.2337/dci19-0028)); ADA Standards of Care, Section 6 ([doi:10.2337/dc25-S006](https://doi.org/10.2337/dc25-S006)) |
| High / spike | > 180 mg/dL, or a rise of 50 mg/dL within 2 hours | Same consensus (time above range); the +50 rise is this project's event rule |
| Urgent | Low, peak > 250, or ≥ 60 min > 180 | 250 mg/dL is the consensus level 2 high; the 60-minute rule is this project's |
| Spike alert | Risk ≥ 0.8, clears below two-thirds of it | Chosen on validation days by F1 (simulated days 6–9) |
| Simulated low alert | Highest validation-day recall with precision ≥ 0.8 | Validation days 6–9 |
| Simulated drug low guard | Gap ≥ 240 min, glucose < 105, fall ≤ −1 mg/dL/min, within 60 min | Chosen on the independent realization ([drug_guard_calibration.json](../reports/drug_guard_calibration.json)) |
| CGMacros low trend rule | ≤ 85 mg/dL (≤ 92 fasting), fall ≥ 1 mg/dL/min, 10-min damping, post-meal guard 92 | Leave-one-participant-out over 36 candidates; all 45 folds chose it |

## 6. Performance

### Forecast (test days)

| Data | Horizon | Twin RMSE | Persistence RMSE | MARD % | Band coverage (target 0.80) | Clarke A+B |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| CGMacros | 30 min | 18.5 | 19.6 | 8.6 | 0.805 | 0.998 |
| CGMacros | 60 min | 26.2 | 28.9 | 12.3 | 0.794 | — |
| CGMacros | 120 min | 31.8 | 38.9 | 15.2 | 0.789 | — |
| Simulated mismatched | 30 min | 13.5 | 20.4 | 5.7 | 0.788 | 0.985 |
| Simulated mismatched | 60 min | 22.9 | 31.2 | 8.5 | 0.765 | — |
| Simulated mismatched | 120 min | 28.1 | 37.4 | 10.5 | 0.766 | — |

On CGMacros the 120-minute error is 18.3% below persistence (95% participant bootstrap 14.9–21.4%); at 60 minutes the bootstrap median reduction is 9.5% (7.0–12.0%). The record prior alone lowers 60-minute error from 30.4 to 26.8; with personal calibration 26.4.

### Alerts (test days)

| Data | Kind | Events | Warned | Recall | Alerts | Precision | False alerts / patient-day | Median lead |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| CGMacros | Spike | 457 | 178 | 0.389 | 282 | 0.638 | 0.43 | 35 min |
| CGMacros | Low | 17 | 7 | 0.412 | 18 | 0.389 | 0.43 | — |
| Simulated | Spike | 254 | 155 | 0.610 | 299 | 0.669 | 0.75 | 105 min |
| Simulated | Low | 16 | 6 | 0.375 | 6 | 1.000 | 0.75 | — |
| Simulated | Urgent (severe events) | 185 | 125 | 0.676 | 230 | 0.835 | 1.7 | — |

### Discrimination and calibration of the continuous risk

Steps are 5-minute test-day steps where the outcome is defined. Intervals come from a participant (CGMacros) or patient (simulated) bootstrap with 1,000 resamples. ECE uses 11 bins.

| Data | Risk | Steps | Base rate | AUROC (95% CI) | AUPRC (95% CI) | Brier (base-rate Brier) | ECE |
| --- | --- | ---: | ---: | --- | --- | --- | ---: |
| CGMacros | Spike, 120 min | 56,943 | 0.199 | 0.685 (0.638–0.730) | 0.373 (0.315–0.436) | 0.1621 (0.1592) | 0.115 |
| CGMacros | Low, 60 min | 66,385 | 0.003 | 0.668 (0.507–0.819) | 0.061 (0.014–0.148) | 0.0035 (0.0031) | 0.003 |
| Simulated | Spike, 120 min | 33,128 | 0.193 | 0.947 (0.916–0.970) | 0.853 (0.751–0.911) | 0.0615 (0.1555) | 0.028 |
| Simulated | Low, 60 min | 37,105 | 0.006 | 0.853 (0.796–0.905) | 0.395 (0.303–0.532) | 0.0049 (0.0064) | 0.004 |

On real data the risk ranks steps better than chance but is not a calibrated probability: both Brier scores are worse than always predicting the base rate. On CGMacros 25.2% of spikes are warned at least 30 minutes ahead, 10.7% at least 60 and 1.1% a full 120.

### Against simple alarms (simulated)

The twin's spike alerts have the highest F1 (0.638) of six methods, level with a 60-minute CGM trend projection (0.637), which raises about three times the false alarms (2.11 vs 0.75 per patient-day) and warns later (median 25 vs 105 minutes). See [ALERT_PROOF.md](ALERT_PROOF.md).

## 7. Subgroups and known limits

| Data | Group | Patients | 60-min twin RMSE | Persistence | Improvement |
| --- | --- | ---: | ---: | ---: | ---: |
| CGMacros | Type 2 | 14 | 32.0 | 35.5 | 9.9% |
| CGMacros | Prediabetes | 16 | 25.0 | 27.6 | 9.4% |
| CGMacros | Healthy | 15 | 21.0 | 22.9 | 8.3% |
| Simulated | Type 2 | 8 | 26.3 | 35.8 | 26.4% |
| Simulated | Prediabetes | 2 | 9.5 | 14.1 | 32.1% |
| Simulated | Healthy | 1 | 7.0 | 8.9 | 21.4% |

- Error is highest in type 2 diabetes, where glucose varies most. Simulated prediabetes and healthy rows rest on 2 and 1 patients.
- No results by sex, age band, ethnicity or BMI band are reported; CGMacros is too small for them and has no Indian participants.
- Lows are rare (17 real, 16 simulated), so low recall and precision have wide intervals (real low-recall Wilson 95% 0.22–0.64).
- The simulated drug guard catches 1 of GT-31's 10 drug lows. Lows after an unlogged snack are invisible to the twin.
- On the simulated ward sleep and HRV help only after a hard night (60-min error 21.59 vs 21.86 within 2 h of a meal), and the record prior does not lower pooled error (22.91 with, 22.81 without), though it doubles warned lows (6 vs 3 of 16).
- Selection that was not blind: the CGMacros low-rule candidate grid was first proposed after looking at test-day false alarms of an earlier run (the per-participant choice among the candidates is blind); the 92 mg/dL post-meal guard on the simulated ward came from a look at test-day false alarms; the one-standard-error trust floor was added after a look at scored days. See [CHANGELOG_EVAL.md](CHANGELOG_EVAL.md).
- The subgroup rule is approximate, not INSPIRED. The medicine term and the wearable sizes are modelling assumptions.

## 8. Safety guardrails

- No dosing and no diagnosis anywhere in the app. The plan table says "Simulation, not advice"; the fasting-day plan warns to review glucose-lowering medicines with the prescriber first, and plan gain weighs minutes under 70 three to six times more than minutes above 180.
- Alerts use hysteresis, a 60-minute suppression window and a daily cap; lows outrank spikes; a CGM gap blocks alerts; compression-low minutes are kept out of the twin and of scored events. Only Urgent alerts interrupt.
- Each alert carries its reasons (meals, walks, sleep, medicine on the curve), and the Two-Stream Inspector shows what the twin does with every record field and wearable signal.
- Per-stream consent: withdrawing the record or wearables removes them from the twin, widens the band (at least ×1.12 and ×1.1) and flows to alerts, plans and the ward ranking.
- The printed clinical note is a template; any number it prints must come from the patient's own facts (`numbersAreAllowed` in `physics.ts`).
- Release gates (`npm run typecheck`, `npm test`, `npm run parity`, `npm run build`) run locally and in GitHub Actions ([ci.yml](../.github/workflows/ci.yml)). `npm test` also checks the committed ward snapshot against a fresh fit, that the forecast and alert risk at time t do not change when anything after t changes, and that `DRUG_LOW_GUARD` equals the independent-realization choice.
- Hazards: [HAZARDS.md](HAZARDS.md); regulatory note: [REGULATORY.md](REGULATORY.md).

## 9. Licences and sources

| Part | Licence |
| --- | --- |
| GlucoTwin code | MIT, copyright 2026 Nikhil Chawla ([LICENSE](../LICENSE)) |
| CGMacros (Das et al., PhysioNet) | CC BY-NC-SA 4.0; raw files are not in the repository, derived files carry the same licence |
| IFCT 2017 (Longvah et al., ICMR-NIN) | Cited food composition values |

Full notes: [DATA_LICENSES.md](../DATA_LICENSES.md). Clinical and epidemiological sources are listed at the end of the [README](../README.md#acknowledgements-and-sources).
