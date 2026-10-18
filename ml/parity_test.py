"""Compare ml/physics.py with the TypeScript fixtures. Tolerance 1e-6."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import sys

sys.dont_write_bytecode = True  # keep ml/ free of __pycache__

from physics import (
    clarke_zone,
    conformal_band,
    find_glucose_events,
    forecast_curve,
    hygiene_fires,
    low_probability,
    meal_offset,
    post_walk_sensitivity,
    score_alert_events,
    spike_probability,
    trend_low_risk,
    twin_low_risk,
    walk_offset,
    wearable_dawn,
    wearable_sensitivity,
)

ROOT = Path(__file__).resolve().parent
FIXTURE = ROOT / "fixtures" / "physics_cases.json"

RENAME = {
    "delayMin": "delay_min",
    "sensPer10g": "sens_per_10g",
    "durationMin": "duration_min",
    "effectPer30": "effect_per_30",
    "suppressionSteps": "suppression_steps",
    "dailyCap": "daily_cap",
    "stepMin": "step_min",
    "mealMin": "meal_min",
}


def snake_kwargs(payload: dict) -> dict:
    return {RENAME.get(key, key): value for key, value in payload.items()}


def close(a: object, b: object, path: str) -> None:
    if isinstance(a, bool) or isinstance(b, bool):
        if a != b:
            raise SystemExit(f"{path}: {a!r} != {b!r}")
        return
    if isinstance(a, (int, float)) and isinstance(b, (int, float)) and not isinstance(a, bool) and not isinstance(b, bool):
        if not math.isclose(float(a), float(b), rel_tol=0, abs_tol=1e-6):
            raise SystemExit(f"{path}: {a} != {b}")
        return
    if isinstance(a, dict) and isinstance(b, dict):
        if set(a) != set(b):
            raise SystemExit(f"{path}: keys {set(a)} != {set(b)}")
        for key in a:
            close(a[key], b[key], f"{path}.{key}")
        return
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            raise SystemExit(f"{path}: length {len(a)} != {len(b)}")
        for index, (left, right) in enumerate(zip(a, b)):
            close(left, right, f"{path}[{index}]")
        return
    if a != b:
        raise SystemExit(f"{path}: {a!r} != {b!r}")


def main() -> None:
    cases = json.loads(FIXTURE.read_text())
    runners = {
        "conformalBand": lambda item: conformal_band(item["input"]["errors"]),
        "twinLowRisk": lambda item: twin_low_risk(item["input"]["current"], item["input"]["points"], item["input"]["context"]),
        "wearableSensitivity": lambda item: wearable_sensitivity(item["input"]["night"], item["input"]["rmssdBaseline"], item["input"]["previous"]),
        "wearableDawn": lambda item: wearable_dawn(item["input"]["night"], item["input"]["rmssdBaseline"], item["input"]["previous"]),
        "postWalkSensitivity": lambda item: post_walk_sensitivity(item["input"]["absMin"], item["input"]["walks"]),
        "lowProbability": lambda item: low_probability(item["input"]["current"], item["input"]["points"]),
        "trendLowRisk": lambda item: trend_low_risk(item["input"]["current"], item["input"]["earlier"], item["input"]["rule"], item["input"]["context"]),
        "forecastCurve": lambda item: forecast_curve(item["input"]),
        "mealOffset": lambda item: meal_offset(**snake_kwargs(item["input"])),
        "walkOffset": lambda item: walk_offset(**snake_kwargs(item["input"])),
        "spikeProbability": lambda item: spike_probability(item["input"]["current"], item["input"]["points"]),
        "hygieneFires": lambda item: hygiene_fires(**snake_kwargs(item["input"])),
        "clarkeZone": lambda item: clarke_zone(item["input"]["reference"], item["input"]["prediction"]),
        "findGlucoseEvents": lambda item: find_glucose_events(**snake_kwargs(item["input"])),
        "scoreAlertEvents": lambda item: score_alert_events(**snake_kwargs(item["input"])),
    }
    for name, run in runners.items():
        bucket = cases[name]
        if len(bucket) != 20:
            raise SystemExit(f"{name} has {len(bucket)} cases, expected 20")
        for index, item in enumerate(bucket):
            close(run(item), item["output"], f"{name}[{index}]")
        print(f"{name}: 20 cases within 1e-6")
    print("physics parity ok")


if __name__ == "__main__":
    sys.path.insert(0, str(ROOT))
    main()
