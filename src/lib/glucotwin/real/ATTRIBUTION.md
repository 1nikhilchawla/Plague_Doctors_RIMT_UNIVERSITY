# CGMacros attribution

The real-data cohort is derived from CGMacros version 1.0.0 on PhysioNet.

- Authors: Anurag Das, David Kerr, Namino Glanz, Wendy Bevier, Rony Santiago, Ricardo Gutierrez-Osuna, Bobak Mortazavi
- DOI: [10.13026/3z8q-x658](https://doi.org/10.13026/3z8q-x658)
- Licence: CC BY-NC-SA 4.0
- Raw CSVs are not in this repository. `ml/download_cgmacros.sh` fetches them into a local directory.

`src/lib/glucotwin/real/real_eval.json` and `demo_patients.json` are computed derivatives: a 5-minute grid, meal macros scaled by amount consumed, and walk bouts from METs. They are not a copy of the source files.

Research prototype — not a medical device, not medical advice.
