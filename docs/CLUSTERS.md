# Approximate Indian type 2 clusters

This is not the published INSPIRED clustering method (Anjana et al., BMJ Open Diabetes Research & Care, 2020). That study used a data-driven partition with measures this record does not have, including C-peptide and GAD antibodies. SIDD and MARD were described as matching European clusters. IROD and CIRDD were described as more specific to South Asians.

GlucoTwin assigns a label with a fixed decision list so a clinician can see why. The code is `assignCluster` in `src/lib/glucotwin/clusters.ts`. First match wins.

| Order | Label | Rule on this record |
|---|---|---|
| — | none | HbA1c under 6.5%. Prediabetes is not forced into a type 2 cluster. |
| 1 | CIRDD | HbA1c at least 8.5%, HOMA-IR at least 4, and HOMA-B under 100 |
| 2 | SIDD | BMI under 25, HbA1c at least 7.5%, HOMA-B under 50, HOMA-IR under 4 |
| 3 | MARD | Age 60 or older and HbA1c under 8.5% |
| 4 | IROD | BMI at least 25 and HOMA-IR at least 2.5 |
| 5 | fallback | MARD if age is at least 50, otherwise IROD |

HOMA-IR = fasting glucose (mg/dL) × fasting insulin (µU/mL) / 405.

HOMA-B = 360 × fasting insulin / (fasting glucose − 63), and is missing when fasting glucose is 63 mg/dL or below.

Triglycerides and HDL are shown on the card when they exist. They do not change the label. The published study used lipids; we do not have a sourced cut-point, so they stay descriptive.

## What differs from the published study

- No C-peptide, no GAD, no cluster centroids, no probability of membership.
- Thresholds above are a modelling assumption so the rule is inspectable. They are not quoted from the paper.
- A person can sit near a boundary and get a different label from a refit of the original cohort.

## Cold-start shift

`applyCluster` adds a fixed shift to the lab prior, then clips. It does not touch the hidden generator and it does not replace the CGMacros ridge. The shift is a modelling assumption, not a published effect size.

| Cluster | Carb per 10 g | Activity per 30 min | Fasting mg/dL | Dawn | Tau min |
|---|---|---|---|---|---|
| SIDD | +2.5 | −2 | +6 | +2 | +15 |
| IROD | +0.8 | −3 | +4 | +1 | +20 |
| CIRDD | +3 | −2 | +10 | +4 | +25 |
| MARD | −0.8 | +1 | −4 | −2 | −10 |
| none | 0 | 0 | 0 | 0 | 0 |

The live curve on the simulated ward still shrinks toward the HbA1c group prior. The cluster shift is the cold-start column.

## Sulfonylurea persona

Divya Menon (GT-31) is simulated. From day 16 the generator multiplies her carb sensitivity by 0.7 and, when a meal was logged more than 4 hours earlier, subtracts 55 mg/dL between 15:00 and 23:00 (40 mg/dL overnight after a 6-hour gap). Dinners are omitted from day 16. That drug term is a modelling assumption. It is not a dosing recommendation. The twin fitted on days 1–5 does not see the new dose; the drift chip is the detection path.
