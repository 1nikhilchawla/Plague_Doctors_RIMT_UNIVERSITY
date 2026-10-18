# Regulatory notes — research prototype

Research prototype — not a medical device, not medical advice. Nothing here is a CDSCO submission.

## Intended use

Clinician decision support for adults with type 2 diabetes or prediabetes. The screen shows a glucose forecast, an alert, and which logged meals and walks are still in the curve.

Out of scope:

- Insulin or tablet dosing
- Diagnosis
- Use in children, pregnancy, type 1 diabetes, or hospital critical care
- Closed-loop insulin delivery
- Replacing a CGM alarm

## Users

A clinician looking at one simulated or CGMacros stream. Not a patient-facing treatment tool in this build.

## Likely CDSCO class

Our assumption, to be confirmed: software that informs a clinical decision without driving a device would be reviewed under the draft CDSCO guidance on medical device software (21 October 2025), risk class A–D depending on the claim. This prototype makes no treatment claim. An AI update that changes the population prior or the residual model would need an Algorithm Change Protocol. This sentence is an assumption, not a regulator's classification.

## Algorithm Change Protocol

| May update from one person's data, inside documented bounds | Needs a new evaluation before it is treated as the reported model |
|---|---|
| Personal carb, activity, fasting, dawn and tau, each clamped (carb 0.5–40, activity 0–80, fasting 70–220, dawn 0–40, tau 40–240) | A change to the meal or walk equation |
| Nightly step capped at ±1.5 carb, ±8 mg/dL fasting, ±2 dawn | A change to the group priors or the cluster shift |
| Conformal band refit on a later window | A LightGBM retrain |
| Kalman bias clamped to ±40 mg/dL | A new alert threshold |

Gate for anything in the right-hand column: `npm test` and `npm run typecheck` stay green, and the mismatched stress test plus the CGMacros horizon table are reprinted into `docs/CHANGELOG_EVAL.md` from code. A worse number is recorded. It is not hidden.

## Consent timing

DPDP Rules were notified on 13 November 2025. Consent-manager duties are described as taking effect on 13 November 2026. Most other duties are described as taking effect on 13 May 2027. This prototype does not operate a consent manager. It does not store an ABHA.

## CGMacros

CGMacros is a United States cohort recruited in Santa Barbara. Results may not transfer to Indian patients.
