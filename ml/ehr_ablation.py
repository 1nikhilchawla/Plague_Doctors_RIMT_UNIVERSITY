"""Leave-one-out record prior. One person in memory at a time.

Does not recompute the published horizon, group, alert, or hybrid tables.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import evaluate_cgmacros as ev  # noqa: E402


def main() -> None:
    bio = ev.load_bio()
    people: list[dict[str, object]] = []
    for subject, person in sorted(bio.items()):
        series = ev.load_participant(subject)
        if series is None:
            continue
        n_days = max(series["dayIndex"]) + 1  # type: ignore[arg-type]
        if n_days < 7:
            continue
        knobs, _isolated, calibration = ev.estimate(series, str(person["group"]))
        people.append({**person, "knobs": knobs, "calibration": calibration, "days": n_days})
        print(f"knobs {person['id']}", flush=True)
    ridge = ev.loo_ridge(people)
    for person, prior in zip(people, ridge):
        person["ehrKnobs"] = prior

    labels = (
        ("none", "No EHR", lambda person: ev.global_knobs()),
        ("group", "Group only", lambda person: ev.POP[str(person["group"])]),
        ("ehr", "EHR prior", lambda person: person["ehrKnobs"]),
        (
            "ehrPersonal",
            "EHR prior + personal calibration",
            lambda person: ev.knobs_toward(person["calibration"], person["ehrKnobs"]),  # type: ignore[arg-type]
        ),
    )
    totals = {arm_id: [0.0, 0] for arm_id, _label, _pick in labels}
    by_subject = {int(person["subject"]): person for person in people}  # type: ignore[arg-type]
    for subject, person in by_subject.items():
        series = ev.load_participant(subject)
        if series is None:
            continue
        for arm_id, _label, pick in labels:
            sse, count = ev.pooled_sse60(series, pick(person))  # type: ignore[arg-type]
            totals[arm_id][0] += sse
            totals[arm_id][1] += count
        print(f"arm {person['id']}", flush=True)
    ablation = []
    for arm_id, label, _pick in labels:
        sse, count = totals[arm_id]
        ablation.append(
            {
                "id": arm_id,
                "label": label,
                "rmse60": ev.round1(math.sqrt(sse / count) if count else 0),
                "n": count,
            }
        )
        print(f"ablation {arm_id} {ablation[-1]['rmse60']} n={count}", flush=True)

    eval_path = ev.OUT_DIR / "real_eval.json"
    real = json.loads(eval_path.read_text())
    real["ablation"] = ablation
    real["ehrBySubject"] = {
        str(person["subject"]): {
            "ehrKnobs": person["ehrKnobs"],
            "calibration": person["calibration"],
        }
        for person in people
        if person["subject"] in set(real.get("demoSubjects", []))
    }
    note = str(real.get("note", ""))
    sentence = " The EHR prior is a leave-one-out ridge on HbA1c, fasting glucose, fasting insulin, HOMA-IR, BMI, age, and sex."
    if "leave-one-out ridge" not in note:
        real["note"] = note.rstrip() + sentence
    eval_path.write_text(json.dumps(ev.json_ready(real), indent=2) + "\n")

    changelog = ev.ROOT / "docs" / "CHANGELOG_EVAL.md"
    previous = changelog.read_text() if changelog.exists() else ""
    lines = [
        "",
        "Cold start, 60-min RMSE, same test days. Printed by `ml/ehr_ablation.py`. Ridge is leave-one-out. The horizon table above was not recomputed.",
        "",
        "| Arm | 60-min RMSE | Points |",
        "|---|---|---|",
    ]
    for arm in ablation:
        lines.append(f"| {arm['label']} | {arm['rmse60']} | {arm['n']} |")
    lines.append("")
    block = "\n".join(lines)
    start = "<!-- CGMACROS_EHR_START -->"
    end = "<!-- CGMACROS_EHR_END -->"
    section = f"{start}\n{block}\n{end}\n"
    marker = "<!-- CGMACROS_EVAL_END -->"
    if start in previous and end in previous:
        previous = previous[: previous.index(start)] + section + previous[previous.index(end) + len(end) :]
    elif marker in previous:
        previous = previous.replace(marker, section + marker, 1)
    else:
        previous = previous.rstrip() + "\n\n" + section
    changelog.write_text(previous if previous.endswith("\n") else previous + "\n")
    print(json.dumps(ablation, indent=2))


if __name__ == "__main__":
    main()
