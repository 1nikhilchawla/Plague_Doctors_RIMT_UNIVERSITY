# Offline ML

Research prototype — not a medical device, not medical advice.

This folder is not the live dashboard. The chart uses the TypeScript physiology curve.

| File | What it does |
| --- | --- |
| `physics.py` | Python port of the meal, walk and dawn curve, used for parity. |
| `parity_test.py` | Compares `ml/fixtures/physics_cases.json` with the Python port. Run `npm run parity` from the repo root. |
| `requirements.txt` | numpy, pandas, LightGBM, scikit-learn. pytest is not required. |
| `download_cgmacros.sh` | Fetches raw CGMacros into a local directory. The CSVs are not committed. |
| `evaluate_cgmacros.py` | Full CGMacros scoring, including the LightGBM residual. A full run needs the raw files and enough memory. The stored horizons live in `src/lib/glucotwin/real/real_eval.json`. Do not hand-edit them. |
| `ehr_ablation.py` | Leave-one-out ridge prior and the ablation block in `real_eval.json`. The ridge is not shifted by the cluster rule. |

LightGBM numbers under `hybrid` in `real_eval.json` are an offline comparison. The dashboard does not add that residual to a forecast.

Attribution: [src/lib/glucotwin/real/ATTRIBUTION.md](../src/lib/glucotwin/real/ATTRIBUTION.md).
