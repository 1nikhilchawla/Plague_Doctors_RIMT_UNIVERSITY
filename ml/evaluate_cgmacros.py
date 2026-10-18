"""CGMacros evaluation. Raw files stay outside the repo. Metrics are written as JSON."""

from __future__ import annotations

import json
import os
import math
import random
from bisect import bisect_right
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.model_selection import GroupKFold

import sys

sys.dont_write_bytecode = True  # keep ml/ free of __pycache__

from physics import (
    circadian,
    clarke_zone,
    clip_glucose,
    conformal_band,
    find_glucose_events,
    forecast_curve,
    hygiene_fires,
    low_probability,
    post_meal_guarded,
    meal_clock_min,
    meal_offset,
    meal_size_factor,
    meal_time_factor,
    order_quantiles,
    quantile,
    score_alert_events,
    spike_probability,
    trend_low_risk,
    trough_within,
    walk_offset,
)

ROOT = Path(__file__).resolve().parents[1]
RAW = Path(os.environ.get("CGMACROS_DIR", "/tmp/cgmacros")) / "raw"
OUT_DIR = ROOT / "src" / "lib" / "glucotwin" / "real"
TIMESTAMP_FMT = "%Y-%m-%d %H:%M:%S"
STEP = 5
DAY = 1440 // STEP
POP = {
    "t2d": {"carbSensitivity": 12.0, "activityEffect": 14.0, "fastingBaseline": 140.0, "dawnAmp": 22.0, "tauMin": 150.0},
    "prediabetes": {"carbSensitivity": 7.2, "activityEffect": 18.0, "fastingBaseline": 106.0, "dawnAmp": 8.0, "tauMin": 100.0},
    "healthy": {"carbSensitivity": 4.4, "activityEffect": 20.0, "fastingBaseline": 92.0, "dawnAmp": 3.0, "tauMin": 70.0},
}


def num(value: object) -> float | None:
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    text = str(value).strip()
    if not text:
        return None
    try:
        parsed = float(text)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def group_of(hba1c: float) -> str:
    # Paper cutoffs are NGSP percent. The dictionary's "mmol/mol" label does not match the 4.6–8.5 range.
    if hba1c < 5.7:
        return "healthy"
    if hba1c <= 6.4:
        return "prediabetes"
    return "t2d"


def homa(glucose: float | None, insulin: float | None) -> float | None:
    if glucose is None or insulin is None or glucose <= 0 or insulin <= 0:
        return None
    return (glucose * insulin) / 405


def load_bio() -> dict[int, dict[str, object]]:
    frame = pd.read_csv(RAW / "bio.csv")
    frame.columns = [column.strip() for column in frame.columns]
    people: dict[int, dict[str, object]] = {}
    for row in frame.to_dict(orient="records"):
        subject = int(row["subject"])
        hba1c = float(row["A1c PDL (Lab)"])
        fasting = num(row["Fasting GLU - PDL (Lab)"])
        insulin = num(row["Insulin"])
        people[subject] = {
            "id": f"CGM-{subject:03d}",
            "subject": subject,
            "age": int(float(row["Age"])),
            "sex": "F" if str(row["Gender"]).strip().upper().startswith("F") else "M",
            "bmi": round(float(row["BMI"]), 1),
            "weightKg": round(float(row["Body weight"]) * 0.45359237, 1),
            "heightCm": round(float(row["Height"]) * 2.54, 1),
            "hba1c": hba1c,
            "fastingGlucose": fasting,
            "fastingInsulin": insulin,
            "homaIr": None if homa(fasting, insulin) is None else round(homa(fasting, insulin), 2),
            "triglycerides": num(row["Triglycerides"]),
            "hdl": num(row["HDL"]),
            "ldl": num(row["LDL (Cal)"]),
            "group": group_of(hba1c),
        }
    return people


def load_participant(subject: int) -> dict[str, object] | None:
    path = RAW / f"CGMacros-{subject:03d}" / f"CGMacros-{subject:03d}.csv"
    if not path.exists():
        return None
    frame = pd.read_csv(path)
    frame.columns = [column.strip() for column in frame.columns]
    stamps = [datetime.strptime(str(value), TIMESTAMP_FMT) for value in frame["Timestamp"]]
    if len(stamps) < 100:
        return None
    first = stamps[0].replace(second=0, microsecond=0)
    first = first.replace(minute=(first.minute // STEP) * STEP)
    origin = first.replace(hour=0, minute=0)
    end = stamps[-1].replace(second=0, microsecond=0)
    end = end.replace(minute=(end.minute // STEP) * STEP)
    bins = int((end - origin).total_seconds() // 60 // STEP) + 1
    if bins < 200:
        return None
    dex: list[list[float]] = [[] for _ in range(bins)]
    libre: list[list[float]] = [[] for _ in range(bins)]
    hr: list[list[float]] = [[] for _ in range(bins)]
    mets: list[list[float]] = [[] for _ in range(bins)]
    meals: list[dict[str, object]] = []
    seen_meals: set[int] = set()
    records = frame.to_dict(orient="records")
    for stamp, row in zip(stamps, records):
        minute = int((stamp - origin).total_seconds() // 60)
        if minute < 0:
            continue
        index = minute // STEP
        if index >= bins:
            continue
        dex_value = num(row.get("Dexcom GL"))
        libre_value = num(row.get("Libre GL"))
        hr_value = num(row.get("HR"))
        met_value = num(row.get("METs"))
        if dex_value is not None:
            dex[index].append(dex_value)
        if libre_value is not None:
            libre[index].append(libre_value)
        if hr_value is not None:
            hr[index].append(hr_value)
        if met_value is not None:
            mets[index].append(met_value / 10)
        # pandas reads an empty cell as NaN, which is truthy: str(NaN) == "nan" used to turn
        # every CGM row into a zero-carb "meal". Only a real meal type or a carb value counts.
        raw_type = row.get("Meal Type")
        meal_type = "" if raw_type is None or (isinstance(raw_type, float) and math.isnan(raw_type)) else str(raw_type).strip()
        if meal_type.lower() == "nan":
            meal_type = ""
        carbs = num(row.get("Carbs"))
        if not meal_type and carbs is None:
            continue
        if minute in seen_meals:
            continue
        seen_meals.add(minute)
        amount = num(row.get("Amount Consumed"))
        scale = 1.0 if amount is None else (amount / 100 if amount > 1.5 else amount)
        meals.append(
            {
                "min": minute,
                "name": meal_type or "Meal",
                "carbs": round((carbs or 0) * scale, 2),
                "fiber": round((num(row.get("Fiber")) or 0) * scale, 2),
                "protein": round((num(row.get("Protein")) or 0) * scale, 2),
                "fat": round((num(row.get("Fat")) or 0) * scale, 2),
                "logged": True,
            }
        )
    paired = []
    for index in range(bins):
        if dex[index] and libre[index]:
            paired.append((sum(dex[index]) / len(dex[index])) - (sum(libre[index]) / len(libre[index])))
    offset = float(np.median(paired)) if paired else 0.0
    glucose: list[float | None] = [None] * bins
    heart: list[float | None] = [None] * bins
    met: list[float | None] = [None] * bins
    gap = [False] * bins
    censored = [False] * bins
    compression = [False] * bins
    worn = [False] * bins
    for index in range(bins):
        dex_mean = sum(dex[index]) / len(dex[index]) if dex[index] else None
        libre_mean = (sum(libre[index]) / len(libre[index]) + offset) if libre[index] else None
        chosen = dex_mean if dex_mean is not None else libre_mean
        if chosen is None:
            gap[index] = True
        else:
            censored[index] = chosen <= 40 or chosen >= 400
            if dex_mean is not None and libre_mean is not None and dex_mean <= 55 and libre_mean >= dex_mean + 30:
                compression[index] = True
            glucose[index] = min(400.0, max(40.0, chosen))
        if hr[index]:
            heart[index] = round(sum(hr[index]) / len(hr[index]))
        if mets[index]:
            met[index] = sum(mets[index]) / len(mets[index])
        worn[index] = heart[index] is not None or met[index] is not None
    walks = []
    run = 0
    run_start = 0
    for index, value in enumerate(met):
        minute = index * STEP
        if value is not None and value >= 3:
            if run == 0:
                run_start = minute
            run += STEP
        else:
            if run >= 10:
                walks.append({"min": run_start, "durationMin": run, "logged": False, "mets": 3.5})
            run = 0
    if run >= 10:
        walks.append({"min": run_start, "durationMin": run, "logged": False, "mets": 3.5})
    day_index = [index // DAY for index in range(bins)]
    return {
        "bins": bins,
        "glucose": glucose,
        "hr": heart,
        "mets": [None if value is None else round(value, 2) for value in met],
        "gap": gap,
        "censored": censored,
        "compression": compression,
        "worn": worn,
        "meals": meals,
        "walks": walks,
        "dayIndex": day_index,
        "clockMin": [(index * STEP) % 1440 for index in range(bins)],
        "libreOffset": round(offset, 2),
        "origin": origin.strftime(TIMESTAMP_FMT),
    }


def shrink(samples: list[float], prior: float, k: float) -> float:
    if not samples:
        return prior
    mean = sum(samples) / len(samples)
    return (len(samples) * mean + k * prior) / (len(samples) + k)


def glucose_at(series: dict[str, object], index: int) -> float | None:
    glucose = series["glucose"]
    if index < 0 or index >= len(glucose):  # type: ignore[arg-type]
        return None
    if series["gap"][index] or series["compression"][index]:  # type: ignore[index]
        return None
    return glucose[index]  # type: ignore[index]


def estimate(series: dict[str, object], group: str, meal_clock: bool = True, residual_mode: str = "plain") -> tuple[dict[str, float], int, dict[str, object]]:
    pop = POP[group]
    meals = [meal for meal in series["meals"] if meal["min"] < 4 * 1440]  # type: ignore[index]
    sens_samples: list[float] = []
    for meal in meals:
        if meal["carbs"] < 8:
            continue
        isolated = all(other is meal or abs(other["min"] - meal["min"]) >= 180 for other in meals)
        if not isolated:
            continue
        index = round(meal["min"] / STEP)
        pre = glucose_at(series, index)
        if pre is None:
            continue
        peak = pre
        last = min(len(series["glucose"]) - 1, index + 30)  # type: ignore[arg-type]
        for cursor in range(index + 1, last + 1):
            value = glucose_at(series, cursor)
            if value is not None and value > peak:
                peak = value
        rise = peak - pre
        if rise < 8:
            continue
        clock = meal_time_factor(meal["min"]) * meal_size_factor(meal["carbs"]) if meal_clock else 1.0
        base = rise / (meal["carbs"] / 10) / clock
        if 0 < base < 40:
            sens_samples.append(base)
    sens = shrink(sens_samples, pop["carbSensitivity"], 3)
    act_samples: list[float] = []
    logged = [meal for meal in meals if meal["logged"]]
    for walk in series["walks"]:  # type: ignore[union-attr]
        if walk["min"] >= 4 * 1440:
            continue
        i0 = round(walk["min"] / STEP)
        i1 = round((walk["min"] + walk["durationMin"]) / STEP)
        g0 = glucose_at(series, i0)
        g1 = glucose_at(series, i1)
        if g0 is None or g1 is None:
            continue
        knobs = {**pop, "carbSensitivity": sens, "activityEffect": 0, "mealClock": meal_clock}
        expected = 0.0
        # Meal and dawn change over the bout, with activity held at zero, is the expected drift.
        from physics import offset_at

        expected = offset_at(walk["min"] + walk["durationMin"], logged, [], knobs) - offset_at(walk["min"], logged, [], knobs)
        expected += circadian(walk["min"] + walk["durationMin"], knobs["dawnAmp"], knobs["fastingBaseline"])
        expected -= circadian(walk["min"], knobs["dawnAmp"], knobs["fastingBaseline"])
        extra = expected - (g1 - g0)
        per30 = extra / (walk["durationMin"] / 30)
        if math.isfinite(per30):
            act_samples.append(min(80, max(0, per30)))
    fasting_samples = []
    for index, clock in enumerate(series["clockMin"]):  # type: ignore[arg-type]
        if series["dayIndex"][index] >= 4:  # type: ignore[index]
            break
        if 3 * 60 <= clock < 6 * 60:
            value = glucose_at(series, index)
            if value is not None:
                fasting_samples.append(value)
    fasting_samples.sort()
    fasting = quantile(fasting_samples, 0.5) if fasting_samples else pop["fastingBaseline"]
    knobs = {
        "carbSensitivity": min(40.0, max(0.5, sens)),
        "activityEffect": min(80.0, max(0.0, shrink(act_samples, pop["activityEffect"], 1))),
        "fastingBaseline": fasting,
        "dawnAmp": pop["dawnAmp"],
        "tauMin": pop["tauMin"],
        "mealClock": meal_clock,
        "mealResidual": residual_mode,
    }
    meta = {
        "carbMean": None if not sens_samples else sum(sens_samples) / len(sens_samples),
        "carbN": len(sens_samples),
        "actMean": None if not act_samples else sum(act_samples) / len(act_samples),
        "actN": len(act_samples),
        "fastingMedian": None if not fasting_samples else quantile(fasting_samples, 0.5),
    }
    return knobs, len(sens_samples), meta


def band_at(ahead: int, bands: dict[int, dict[str, float]]) -> dict[str, float]:
    def mix(a: dict[str, float], b: dict[str, float], t: float) -> dict[str, float]:
        return {"q10": a["q10"] + (b["q10"] - a["q10"]) * t, "q90": a["q90"] + (b["q90"] - a["q90"]) * t}

    if ahead <= 0:
        return {"q10": 0, "q90": 0}
    if ahead <= 30:
        return mix({"q10": 0, "q90": 0}, bands[30], ahead / 30)
    if ahead <= 60:
        return mix(bands[30], bands[60], (ahead - 30) / 30)
    return mix(bands[60], bands[120], min(1, (ahead - 60) / 60))


def physiology(series: dict[str, object], knobs: dict[str, float]) -> tuple[np.ndarray, list[int], dict[int, list[np.ndarray]], list[int], dict[int, list[np.ndarray]]]:
    bins = int(series["bins"])  # type: ignore[arg-type]
    level = np.zeros(bins)
    meals_by_start: dict[int, list[np.ndarray]] = defaultdict(list)
    walks_by_start: dict[int, list[np.ndarray]] = defaultdict(list)
    for index in range(bins):
        level[index] = circadian(index * STEP, knobs["dawnAmp"], knobs["fastingBaseline"])
    for meal in series["meals"]:  # type: ignore[union-attr]
        if not meal["logged"]:
            continue
        start = int(round(meal["min"] / STEP))
        contrib = np.zeros(bins)
        for delay_step in range(0, 37):
            idx = start + delay_step
            if 0 <= idx < bins:
                contrib[idx] = meal_offset(delay_step * STEP, meal["carbs"], meal["fiber"], knobs["carbSensitivity"], meal_clock_min(meal, knobs))
        level += contrib
        meals_by_start[start].append(contrib)
    for walk in series["walks"]:  # type: ignore[union-attr]
        start = int(round(walk["min"] / STEP))
        span = int(math.ceil((walk["durationMin"] + 75) / STEP)) + 1
        contrib = np.zeros(bins)
        for delay_step in range(0, span):
            idx = start + delay_step
            if 0 <= idx < bins:
                contrib[idx] = walk_offset(delay_step * STEP, walk["durationMin"], knobs["activityEffect"])
        level += contrib
        walks_by_start[start].append(contrib)
    return level, sorted(meals_by_start), meals_by_start, sorted(walks_by_start), walks_by_start


def future_offset(index: int, j: int, starts: list[int], by_start: dict[int, list[np.ndarray]]) -> float:
    lo = bisect_right(starts, index)
    hi = bisect_right(starts, j)
    total = 0.0
    for start in starts[lo:hi]:
        for contrib in by_start[start]:
            total += float(contrib[j])
    return total


def curve_p50(
    index: int,
    steps: int,
    current: float,
    level: np.ndarray,
    meal_starts: list[int],
    meals_by_start: dict[int, list[np.ndarray]],
    walk_starts: list[int],
    walks_by_start: dict[int, list[np.ndarray]],
    tau: float,
    scaled: bool = False,
) -> list[float] | None:
    if index < 0 or index + steps >= len(level):
        return None
    residual = current - float(level[index])
    # Meal-scaled negative residual (physics.ts forecastCurve): meals started by now whose
    # contribution is still running (36 steps = 180 min) share any shortfall in proportion.
    started = [contrib for start in meal_starts[bisect_right(meal_starts, index - 37) : bisect_right(meal_starts, index)] for contrib in meals_by_start[start]]
    meal_now = sum(float(contrib[index]) for contrib in started)
    meal_residual = max(residual, -meal_now) if scaled and meal_now > 0 and residual < 0 else 0.0
    meal_scale = (meal_now + meal_residual) / meal_now if meal_now > 0 else 1.0
    points: list[float] = []
    for step in range(0, steps + 1):
        j = index + step
        future = 0.0 if step == 0 else future_offset(index, j, meal_starts, meals_by_start) + future_offset(index, j, walk_starts, walks_by_start)
        ahead = step * STEP
        decay = math.exp(-ahead / max(30.0, tau))
        started_later = sum(float(contrib[j]) for contrib in started) if meal_residual else 0.0
        points.append(clip_glucose(float(level[j]) - future - (1 - meal_scale) * started_later + (residual - meal_residual) * decay))
    return points


def widen(preds: list[float], bands: dict[int, dict[str, float]]) -> list[dict[str, float]]:
    points = []
    for step, pred in enumerate(preds):
        ahead = step * STEP
        width = band_at(ahead, bands)
        p10, p50, p90 = order_quantiles(pred + width["q10"], pred, pred + width["q90"])
        points.append({"minutesAhead": ahead, "p10": p10, "p50": p50, "p90": p90})
    return points


def assert_fast_path() -> None:
    series = {
        "bins": 90,
        "meals": [{"min": 120, "carbs": 45, "fiber": 5, "logged": True}],
        "walks": [{"min": 240, "durationMin": 30}],
    }
    for mode in ("plain", "scaled"):
        assert_fast_path_mode({**POP["t2d"], "mealResidual": mode}, series)


def assert_fast_path_mode(knobs: dict[str, object], series: dict[str, object]) -> None:
    level, meal_starts, meals_by_start, walk_starts, walks_by_start = physiology(series, knobs)  # type: ignore[arg-type]
    for index in (10, 20, 30, 50):
        for steps in (6, 12, 24):
            fast = curve_p50(index, steps, 128.0, level, meal_starts, meals_by_start, walk_starts, walks_by_start, knobs["tauMin"], knobs.get("mealResidual") == "scaled")
            curve = forecast_curve(
                {
                    "nowMin": index * STEP,
                    "glucoseNow": 128.0,
                    "meals": [meal for meal in series["meals"] if meal["min"] <= index * STEP],
                    "walks": [walk for walk in series["walks"] if walk["min"] <= index * STEP],
                    "knobs": knobs,
                    "band": {"q10": 0, "q90": 0},
                    "horizonMin": steps * STEP,
                }
            )
            if fast is None or abs(fast[-1] - curve[-1]["p50"]) > 1e-6:
                raise SystemExit(f"fast path diverged at {index}+{steps}: {None if fast is None else fast[-1]} vs {curve[-1]['p50']}")


# Trend rule for lows (ml/physics.py trend_low_risk, mirrored in physics.ts). It
# fires only near the low range (current <= 88, or <= 95 with no meal of 15 g or
# more in the last 120 min), when CGM fell at least `fallRate` mg/dL/min over
# the last 15 min and the damped 15-min projection, averaged with the twin's
# 30-min trough, is below 70. Rate and damping (or no rule) are picked by pooled
# low-alert F1, leave-one-participant-out (see lopo_low_rules). Each candidate
# also sets the guard ceilings and the twin's post-meal guard (92 mg/dL or off).
LOW_TREND_RULES: list[dict[str, float | None]] = [
    {
        "aheadMin": 15,
        "fallRate": rate,
        "dampMin": damp,
        "blend": 0.5,
        "ceiling": ceiling,
        "ceilingFasting": fasting,
        "postMealCeiling": post_meal,
    }
    for rate in (-1.0, -1.5, -2.0)
    for damp in (10.0, 20.0)
    for ceiling, fasting in ((85.0, 92.0), (88.0, 95.0), (92.0, 100.0))
    for post_meal in (92.0, None)
]


def minutes_since_meal(meals: list[dict[str, object]], now: float, min_carbs: float = 15) -> float | None:
    last = None
    for meal in meals:
        if meal["logged"] and meal["carbs"] >= min_carbs and meal["min"] <= now and (last is None or meal["min"] > last):
            last = meal["min"]
    return None if last is None else now - last


def score_alerts(person: dict[str, object], rule: dict[str, float] | None, first_day: int, end_day: int) -> dict[str, object]:
    """Alerts with hygiene on days [first_day, end_day); every other day is a gap."""
    inputs = person["alertInputs"]
    series = person["series"]
    days = series["dayIndex"]  # type: ignore[index]
    samples = []
    for index, row in enumerate(inputs["base"]):  # type: ignore[index]
        day = days[index]
        if row is None or not first_day <= day < end_day:
            samples.append({"spike": 0, "low": 0, "gap": True, "day": day})
            continue
        spike, raw_low, current, earlier, trough30, since = row
        ceiling = rule.get("postMealCeiling", 92) if rule else 92
        low = 0.0 if post_meal_guarded(current, since, ceiling) else raw_low
        trend = trend_low_risk(current, earlier, rule, {"twinTrough30": trough30, "minutesSinceMeal": since})
        samples.append({"spike": spike, "low": max(low, trend), "gap": False, "day": day})
    fires = hygiene_fires(samples)
    alerts = [{"index": index, "kind": kind} for index, kind in enumerate(fires) if kind and first_day <= days[index] < end_day]
    events = inputs["events"]  # type: ignore[index]
    spikes = [index for index in events["spikes"] if first_day <= days[index] < end_day]
    lows = [index for index in events["lows"] if first_day <= days[index] < end_day]
    scored = score_alert_events(spikes, lows, alerts, STEP)
    # Lead time is reported for spikes, as on the simulated ward.
    scored["spikeLeads"] = score_alert_events(spikes, [], alerts, STEP)["leads"]
    return scored


def _low_f1(events: int, hits: int, alerts: int, false: int) -> float:
    recall = hits / events if events else 0.0
    precision = (alerts - false) / alerts if alerts else 0.0
    return 2 * recall * precision / (recall + precision) if recall + precision else 0.0


def lopo_low_rules(people: list[dict[str, object]]) -> tuple[list[int], list[dict[str, object]]]:
    """Leave-one-participant-out choice of the low rule and its guards.

    Every candidate is scored on every participant's test days (day 7 on). Each
    participant then gets the candidate with the best pooled low-alert F1 on the
    other participants (ties: fewer low alerts, then grid order), so no one's
    own scored days inform their own rule.
    """
    table = [[score_alerts(person, rule, 6, 10**6) for rule in LOW_TREND_RULES] for person in people]
    keys = ("lowEvents", "lowHits", "lowAlerts", "lowFalse")
    totals = [{key: sum(row[k][key] for row in table) for key in keys} for k, _ in enumerate(LOW_TREND_RULES)]
    choices = []
    for own in table:
        best = None
        for k, total in enumerate(totals):
            others = {key: total[key] - own[k][key] for key in keys}
            score = (round(_low_f1(others["lowEvents"], others["lowHits"], others["lowAlerts"], others["lowFalse"]), 6), -others["lowAlerts"], -k)
            if best is None or score > best[0]:
                best = (score, k)
        choices.append(best[1])
    rows = []
    for k, (rule, total) in enumerate(zip(LOW_TREND_RULES, totals)):
        rows.append({
            "rule": rule,
            "lowEvents": total["lowEvents"],
            "lowHits": total["lowHits"],
            "lowAlerts": total["lowAlerts"],
            "lowFalse": total["lowFalse"],
            "f1AllParticipants": round(_low_f1(total["lowEvents"], total["lowHits"], total["lowAlerts"], total["lowFalse"]), 3),
            "chosenFor": choices.count(k),
        })
    for person, k, own in zip(people, choices, table):
        person["alertScore"] = own[k]
        person["lowRuleIndex"] = k
    return choices, rows


ECE_EDGES = (0.0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1.0000001)


def risk_rows(person: dict[str, object], rule: dict[str, float | None]) -> dict[str, list[tuple[float, int]]]:
    """Continuous spike and low risk on test days (day 7 on) with their outcomes, as scripts/alert-proof.ts defines them."""
    series = person["series"]
    days = series["dayIndex"]  # type: ignore[index]
    spike_rows: list[tuple[float, int]] = []
    low_rows: list[tuple[float, int]] = []
    for index, row in enumerate(person["alertInputs"]["base"]):  # type: ignore[index]
        if row is None or days[index] < 6:
            continue
        spike, raw_low, current, earlier, trough30, since = row
        low = 0.0 if post_meal_guarded(current, since, rule.get("postMealCeiling", 92)) else raw_low
        low = max(low, trend_low_risk(current, earlier, rule, {"twinTrough30": trough30, "minutesSinceMeal": since}))
        future = [glucose_at(series, index + k) for k in range(1, 25)]
        if current <= 180:
            ahead = [value for value in future if value is not None]
            if len(ahead) >= 18:
                spike_rows.append((spike, int(any(value > 180 or value >= current + 50 for value in ahead))))
        if current >= 70:
            ahead = [value for value in future[:12] if value is not None]
            if len(ahead) >= 9:
                low_rows.append((low, int(any(value < 70 for value in ahead))))
    return {"spike": spike_rows, "low": low_rows}


def _interval(values: list[float]) -> list[float] | None:
    if not values:
        return None
    return [round(float(np.quantile(values, 0.025)), 3), round(float(np.quantile(values, 0.975)), 3)]


def _discrimination(per_person: list[list[tuple[float, int]]], target: str, resamples: int = 1000) -> dict[str, object]:
    from sklearn.metrics import average_precision_score, roc_auc_score

    groups = [np.array(rows, dtype=float).reshape(-1, 2) for rows in per_person if rows]
    pooled = np.concatenate(groups)
    p, y = pooled[:, 0], pooled[:, 1]
    base = float(y.mean())
    brier = float(np.mean((p - y) ** 2))
    climatology = float(np.mean((base - y) ** 2))
    ece = 0.0
    for lo, hi in zip(ECE_EDGES[:-1], ECE_EDGES[1:]):
        mask = (p >= lo) & (p < hi)
        if mask.any():
            ece += mask.mean() * abs(p[mask].mean() - y[mask].mean())
    rng = np.random.default_rng(42)
    aucs, aps = [], []
    for _ in range(resamples):
        pick = rng.integers(0, len(groups), size=len(groups))
        sample = np.concatenate([groups[i] for i in pick])
        if 0 < sample[:, 1].sum() < len(sample):
            aucs.append(roc_auc_score(sample[:, 1], sample[:, 0]))
            aps.append(average_precision_score(sample[:, 1], sample[:, 0]))
    return {
        "target": target,
        "steps": int(len(y)),
        "baseRate": round(base, 4),
        "auroc": round(float(roc_auc_score(y, p)), 3),
        "aurocCi": _interval(aucs),
        "auprc": round(float(average_precision_score(y, p)), 3),
        "auprcCi": _interval(aps),
        "brier": round(brier, 4),
        "brierClimatology": round(climatology, 4),
        "brierSkill": round(1 - brier / climatology, 3) if climatology else None,
        "ece": round(float(ece), 3),
        "ciMethod": f"participant bootstrap, {resamples} resamples",
    }


def global_knobs() -> dict[str, float]:
    keys = ("carbSensitivity", "activityEffect", "fastingBaseline", "dawnAmp", "tauMin")
    return {key: sum(POP[group][key] for group in POP) / 3 for key in keys}


def loo_ridge(people: list[dict[str, object]], alpha: float = 1.0) -> list[dict[str, float]]:
    """Leave-one-out ridge. Features are standardized on the other people only."""
    rows = []
    for person in people:
        rows.append(
            [
                person["hba1c"],
                person["fastingGlucose"],
                person["fastingInsulin"],
                person["homaIr"],
                person["bmi"],
                float(person["age"]),  # type: ignore[arg-type]
                1.0 if person["sex"] == "F" else 0.0,
            ]
        )
    features = np.asarray(rows, dtype=float)
    names = ("carbSensitivity", "activityEffect", "fastingBaseline")
    targets = {name: np.array([person["knobs"][name] for person in people], dtype=float) for name in names}  # type: ignore[index]
    n = len(people)
    fitted: list[dict[str, float]] = []
    for hold in range(n):
        train = np.ones(n, dtype=bool)
        train[hold] = False
        block = features[train].copy()
        row = features[hold].copy()
        for col in range(block.shape[1]):
            finite = block[np.isfinite(block[:, col]), col]
            fill = float(np.median(finite)) if finite.size else 0.0
            block[~np.isfinite(block[:, col]), col] = fill
            if not np.isfinite(row[col]):
                row[col] = fill
        center = block.mean(axis=0)
        scale = block.std(axis=0)
        scale[scale < 1e-6] = 1.0
        z_train = (block - center) / scale
        z_row = (row - center) / scale
        prediction: dict[str, float] = {}
        for name in names:
            y = targets[name][train]
            y_mean = float(y.mean())
            gram = z_train.T @ z_train + alpha * np.eye(z_train.shape[1])
            beta = np.linalg.solve(gram, z_train.T @ (y - y_mean))
            prediction[name] = float(z_row @ beta + y_mean)
        group = str(people[hold]["group"])
        fitted.append(
            {
                "carbSensitivity": min(40.0, max(0.5, prediction["carbSensitivity"])),
                "activityEffect": min(80.0, max(0.0, prediction["activityEffect"])),
                "fastingBaseline": min(220.0, max(70.0, prediction["fastingBaseline"])),
                "dawnAmp": POP[group]["dawnAmp"],
                "tauMin": POP[group]["tauMin"],
            }
        )
    return fitted


def knobs_toward(calibration: dict[str, object], prior: dict[str, float]) -> dict[str, float]:
    carb = prior["carbSensitivity"]
    if int(calibration["carbN"]) > 0 and calibration["carbMean"] is not None:  # type: ignore[arg-type]
        carb = (float(calibration["carbN"]) * float(calibration["carbMean"]) + 3 * prior["carbSensitivity"]) / (float(calibration["carbN"]) + 3)
    activity = prior["activityEffect"]
    if int(calibration["actN"]) > 0 and calibration["actMean"] is not None:  # type: ignore[arg-type]
        activity = (float(calibration["actN"]) * float(calibration["actMean"]) + prior["activityEffect"]) / (float(calibration["actN"]) + 1)
    fasting = prior["fastingBaseline"] if calibration["fastingMedian"] is None else float(calibration["fastingMedian"])  # type: ignore[arg-type]
    return {
        "carbSensitivity": min(40.0, max(0.5, carb)),
        "activityEffect": min(80.0, max(0.0, activity)),
        "fastingBaseline": fasting,
        "dawnAmp": prior["dawnAmp"],
        "tauMin": prior["tauMin"],
    }


def pooled_sse60(series: dict[str, object], knobs: dict[str, float]) -> tuple[float, int]:
    level, meal_starts, meals_by_start, walk_starts, walks_by_start = physiology(series, knobs)
    sse = 0.0
    count = 0
    for index, day in enumerate(series["dayIndex"]):  # type: ignore[arg-type]
        if day < 6 or index % 6:
            continue
        current = glucose_at(series, index)
        actual = glucose_at(series, index + 12)
        if current is None or actual is None:
            continue
        preds = curve_p50(index, 12, current, level, meal_starts, meals_by_start, walk_starts, walks_by_start, knobs["tauMin"], knobs.get("mealResidual") == "scaled")
        if preds is None or len(preds) <= 12:
            continue
        err = preds[12] - actual
        sse += err * err
        count += 1
    return sse, count


def round1(value: float) -> float:
    # Match Math.round(n * 10) / 10, including halves.
    scaled = value * 10
    if scaled >= 0:
        return math.floor(scaled + 0.5) / 10
    return math.ceil(scaled - 0.5) / 10


def metrics_from(rows: list[dict[str, float]]) -> dict[str, float | None]:
    if not rows:
        return {"rmse": None, "mae": None, "mard": None, "coverage": None, "clarkeApb": None, "n": 0}
    n = len(rows)
    sse = sum(row["err"] ** 2 for row in rows)
    mae = sum(abs(row["err"]) for row in rows) / n
    mard_rows = [row for row in rows if row["actual"] >= 40]
    mard = sum(abs(row["err"]) / row["actual"] * 100 for row in mard_rows) / max(1, len(mard_rows))
    cover = sum(1 for row in rows if row["covered"]) / n
    clarke_rows = [row for row in rows if row["horizon"] == 30]
    clarke = None
    if clarke_rows:
        clarke = sum(1 for row in clarke_rows if clarke_zone(row["actual"], row["pred"]) in ("A", "B")) / len(clarke_rows)
    return {
        "rmse": round1(math.sqrt(sse / n)),
        "mae": round1(mae),
        "mard": round1(mard),
        "coverage": round(cover, 3),
        "clarkeApb": None if clarke is None else round(clarke, 3),
        "n": n,
    }


def bootstrap_ci(values: list[float], rng: random.Random) -> list[float]:
    if not values:
        return [0, 0]
    means = []
    for _ in range(800):
        draw = [values[rng.randrange(len(values))] for _ in values]
        means.append(sum(draw) / len(draw))
    means.sort()
    return [round1(means[int(0.025 * len(means))]), round1(means[math.ceil(0.975 * len(means)) - 1])]


def apply_trend_correction(people: list[dict[str, object]]) -> dict[str, dict[str, float]]:
    """Short-horizon trend correction: pred += gain * slope30 * horizon + bias.

    Each participant's coefficients are fit on the other participants' test rows
    only (leave one participant out), so nobody's own errors tune their forecast.
    Their band is then refit on their own calibration days (4-5) after the same
    correction, finite-sample conformal, so the band matches the corrected
    centre. The exported coefficients are the fit on everyone's uncorrected test
    rows, computed before any row is changed.
    """

    def fit(rows: list[dict[str, float]], horizon: int) -> np.ndarray:
        if not rows:
            return np.zeros(2)
        x = np.array([[row["slope"] * horizon, 1.0] for row in rows])
        y = np.array([row["actual"] - row["pred"] for row in rows])
        if y.size == 0:
            return np.zeros(2)
        return np.linalg.solve(x.T @ x + np.eye(2), x.T @ y)

    exported: dict[str, dict[str, float]] = {}
    coefs_by_horizon: dict[int, list[np.ndarray]] = {}
    for horizon in (30, 60, 120):
        rows_by = [person["rows"][horizon] for person in people]  # type: ignore[index]
        everyone = fit([row for rows in rows_by for row in rows], horizon)
        exported[str(horizon)] = {"slopeGain": round(float(everyone[0]), 4), "bias": round(float(everyone[1]), 3)}
        coefs = []
        for held_out, _ in enumerate(rows_by):
            others = [row for j, rows in enumerate(rows_by) if j != held_out for row in rows]
            coefs.append(fit(others, horizon) if others else np.zeros(2))
        coefs_by_horizon[horizon] = coefs
    for i, person in enumerate(people):
        trend: dict[str, dict[str, float]] = {}
        trend_bands: dict[int, dict[str, float]] = {}
        for horizon in (30, 60, 120):
            coef = coefs_by_horizon[horizon][i]
            trend[str(horizon)] = {"slopeGain": round(float(coef[0]), 4), "bias": round(float(coef[1]), 3)}
            gain, bias = trend[str(horizon)]["slopeGain"], trend[str(horizon)]["bias"]
            residuals = [
                row["actual"] - (row["pred"] + gain * row["slope"] * horizon + bias)
                for row in person["calRows"][horizon]  # type: ignore[index]
            ]
            band = conformal_band(residuals)
            trend_bands[horizon] = band
            for row in person["rows"][horizon]:  # type: ignore[index]
                pred = row["pred"] + gain * row["slope"] * horizon + bias
                p10, p50, p90 = order_quantiles(pred + band["q10"], pred, pred + band["q90"])
                row["pred"] = p50
                row["err"] = p50 - row["actual"]
                row["covered"] = p10 <= row["actual"] <= p90
        person["trend"] = trend
        person["trendBands"] = {str(key): value for key, value in trend_bands.items()}
        del person["calRows"]
        rows = person["rows"]  # type: ignore[assignment]
        person["fit"]["rmse60"] = metrics_from(rows[60])["rmse"] or 0  # type: ignore[index]
        person["fit"]["rmse120"] = metrics_from(rows[120])["rmse"] or 0  # type: ignore[index]
    return exported


TRUST_STEPS = (1.0, 0.75, 0.5, 0.25, 0.0)
KNOB_KEYS = ("carbSensitivity", "activityEffect", "fastingBaseline", "dawnAmp", "tauMin")


def blend_knobs(prior: dict[str, float], personal: dict[str, float], trust: float) -> dict[str, float]:
    blended = {key: prior[key] + trust * (personal[key] - prior[key]) for key in KNOB_KEYS}
    return {**blended, "mealClock": personal.get("mealClock", True), "mealResidual": personal.get("mealResidual", "plain")}


def validation_errors(series: dict[str, object], knobs: dict[str, float]) -> list[list[float]]:
    """Squared 60-min errors on validation days 5–6 (every 15 min), grouped by day, as cohort.ts does."""
    level, meal_starts, meals_by_start, walk_starts, walks_by_start = physiology(series, knobs)
    by_day: list[list[float]] = [[], []]
    for index, day in enumerate(series["dayIndex"]):  # type: ignore[index]
        if day < 4 or day >= 6 or index % 3:
            continue
        current = glucose_at(series, index)
        actual = glucose_at(series, index + 12)
        if current is None or actual is None:
            continue
        preds = curve_p50(index, 12, current, level, meal_starts, meals_by_start, walk_starts, walks_by_start, knobs["tauMin"], knobs.get("mealResidual") == "scaled")
        if preds is None:
            continue
        by_day[day - 4].append((preds[12] - actual) ** 2)
    return by_day


def clearly_better(candidate: list[list[float]], baseline: list[list[float]]) -> bool:
    diffs = []
    for errors, base in zip(candidate, baseline):
        if not errors or len(errors) != len(base):
            continue
        diffs.append(sum(base) / len(base) - sum(errors) / len(errors))
    if len(diffs) < 2:
        return False
    gain = sum(diffs) / len(diffs)
    sd = math.sqrt(sum((value - gain) ** 2 for value in diffs) / (len(diffs) - 1))
    return gain > sd / math.sqrt(len(diffs))


def choose_trust(series: dict[str, object], personal: dict[str, float], prior: dict[str, float]) -> tuple[dict[str, float], float]:
    """cohort.ts chooseTrust on real files: the blend toward the personal fit with the lowest
    validation error, floored to the group prior unless it is better by more than one SE."""
    best_trust, best_err = 1.0, math.inf
    for trust in TRUST_STEPS:
        flat = [value for day in validation_errors(series, blend_knobs(prior, personal, trust)) for value in day]
        err = math.sqrt(sum(flat) / len(flat)) if flat else math.inf
        if err < best_err - 1e-6:
            best_trust, best_err = trust, err
    if best_trust > 0 and not clearly_better(
        validation_errors(series, blend_knobs(prior, personal, best_trust)), validation_errors(series, prior)
    ):
        best_trust = 0.0
    return blend_knobs(prior, personal, best_trust), best_trust


def choose_meal_clock(participants: list[dict[str, object]]) -> tuple[bool, dict[str, float | None]]:
    """Meal clock and size factors on or off for this dataset: pooled 60-min RMSE on validation days 5–6."""
    raw: dict[str, float | None] = {}
    for clock in (True, False):
        sse = 0.0
        count = 0
        for person in participants:
            series = person["series"]
            knobs = estimate(series, str(person["group"]), clock)[0]  # type: ignore[arg-type]
            level, meal_starts, meals_by_start, walk_starts, walks_by_start = physiology(series, knobs)  # type: ignore[arg-type]
            for index, day in enumerate(series["dayIndex"]):  # type: ignore[index]
                if day < 4 or day >= 6 or index % 6:
                    continue
                current = glucose_at(series, index)  # type: ignore[arg-type]
                actual = glucose_at(series, index + 12)  # type: ignore[arg-type]
                if current is None or actual is None:
                    continue
                preds = curve_p50(index, 12, current, level, meal_starts, meals_by_start, walk_starts, walks_by_start, knobs["tauMin"], knobs.get("mealResidual") == "scaled")
                if preds is None:
                    continue
                sse += (preds[12] - actual) ** 2
                count += 1
        raw["on" if clock else "off"] = math.sqrt(sse / count) if count else None
    chosen = raw["on"] is not None and (raw["off"] is None or raw["on"] <= raw["off"])
    return chosen, {key: None if value is None else round1(value) for key, value in raw.items()}


def choose_residual_mode(participants: list[dict[str, object]], meal_clock: bool) -> tuple[str, dict[str, float | None]]:
    """Meal-scaled or plain residual for this dataset: pooled 60-min RMSE of the personal twin on validation days 5–6."""
    raw: dict[str, float | None] = {}
    for mode in ("plain", "scaled"):
        sse = 0.0
        count = 0
        for person in participants:
            series = person["series"]
            knobs = estimate(series, str(person["group"]), meal_clock, mode)[0]  # type: ignore[arg-type]
            level, meal_starts, meals_by_start, walk_starts, walks_by_start = physiology(series, knobs)  # type: ignore[arg-type]
            for index, day in enumerate(series["dayIndex"]):  # type: ignore[index]
                if day < 4 or day >= 6 or index % 6:
                    continue
                current = glucose_at(series, index)  # type: ignore[arg-type]
                actual = glucose_at(series, index + 12)  # type: ignore[arg-type]
                if current is None or actual is None:
                    continue
                preds = curve_p50(index, 12, current, level, meal_starts, meals_by_start, walk_starts, walks_by_start, knobs["tauMin"], mode == "scaled")
                if preds is None:
                    continue
                sse += (preds[12] - actual) ** 2
                count += 1
        raw[mode] = math.sqrt(sse / count) if count else None
    chosen = "scaled" if raw["scaled"] is not None and raw["plain"] is not None and raw["scaled"] < raw["plain"] else "plain"
    return chosen, {key: None if value is None else round1(value) for key, value in raw.items()}


def json_ready(value: object) -> object:
    if isinstance(value, dict):
        return {str(key): json_ready(item) for key, item in value.items()}
    if isinstance(value, list):
        return [json_ready(item) for item in value]
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, (np.floating, np.integer)):
        return value.item()
    return value


def _bootstrap_rmse_reduction(stored: list[dict[str, object]], n: int = 1000, seed: int = 42) -> dict[str, object]:
    """Participant-level bootstrap of the twin's RMSE reduction vs persistence.

    Uses the same test-day rows as the reported horizons (the trend-corrected
    twin and the persistence baseline). Each resample draws participants with
    replacement, pools their squared errors, and records the fractional
    reduction; the interval is the 2.5 / 97.5 percentile over `n` resamples.
    """
    rng = np.random.default_rng(seed)
    horizons = (60, 120)
    sums = []
    for person in stored:
        entry = {}
        for horizon in horizons:
            twin = person["rows"][horizon]  # type: ignore[index]
            pers = person["baselines"]["persistence"][horizon]  # type: ignore[index]
            entry[horizon] = (
                sum(row["err"] ** 2 for row in twin),
                len(twin),
                sum(row["err"] ** 2 for row in pers),
                len(pers),
            )
        sums.append(entry)
    if not sums:
        return {"resamples": 0}
    table = {h: np.array([entry[h] for entry in sums], dtype=float) for h in horizons}
    reductions: dict[int, list[float]] = {h: [] for h in horizons}
    for _ in range(n):
        pick = rng.integers(0, len(sums), size=len(sums))
        for horizon in horizons:
            twin_sse, twin_n, pers_sse, pers_n = table[horizon][pick].sum(axis=0)
            if twin_n and pers_n and pers_sse:
                twin_rmse = math.sqrt(twin_sse / twin_n)
                pers_rmse = math.sqrt(pers_sse / pers_n)
                reductions[horizon].append((pers_rmse - twin_rmse) / pers_rmse)
    if not all(reductions.values()):
        return {"resamples": 0}

    def interval(values: list[float]) -> dict[str, float]:
        return {
            "low": round(float(np.quantile(values, 0.025)), 4),
            "high": round(float(np.quantile(values, 0.975)), 4),
            "median": round(float(np.quantile(values, 0.5)), 4),
        }

    return {
        "resamples": n,
        "horizonMin60": {"reduction": interval(reductions[60])},
        "horizonMin120": {"reduction": interval(reductions[120])},
    }


def main() -> None:
    assert_fast_path()
    bio = load_bio()
    participants = []
    skipped = []
    for subject, person in sorted(bio.items()):
        series = load_participant(subject)
        if series is None:
            skipped.append(subject)
            continue
        n_days = max(series["dayIndex"]) + 1  # type: ignore[arg-type]
        if n_days < 7:
            skipped.append(subject)
            continue
        person = dict(person)
        person["series"] = series
        person["days"] = n_days
        participants.append(person)
    meal_clock, meal_clock_rmse = choose_meal_clock(participants)
    print(f"meal clock chosen on validation days 5–6: {meal_clock} (validation 60-min RMSE {meal_clock_rmse})", flush=True)
    residual_mode, residual_rmse = choose_residual_mode(participants, meal_clock)
    print(f"meal residual chosen on validation days 5–6: {residual_mode} (validation 60-min RMSE {residual_rmse})", flush=True)
    feature_rows = []
    stored = []
    for person in participants:
        series = person["series"]
        personal, isolated, calibration = estimate(series, person["group"], meal_clock, residual_mode)
        person["calibration"] = calibration
        pop = {**POP[person["group"]], "mealClock": meal_clock, "mealResidual": residual_mode}
        # The prior keeps the person's measured overnight (03:00-06:00) fasting level: it is a
        # direct reading, not a fitted response. Chosen on validation days 5–6 (60-min RMSE
        # 26.9 vs 27.3 with the plain group prior), after a test-day look at the same comparison.
        anchored = {**pop, "fastingBaseline": personal["fastingBaseline"]} if calibration["fastingMedian"] is not None else pop
        knobs, trust = choose_trust(series, personal, anchored)
        person["personalTrust"] = trust
        # Stored once for the ehrPersonal arm below: it runs its own trust
        # selection between this personal fit and the ridge prior, on the same
        # validation days, with the same 1-SE floor.
        person["personalFit"] = personal
        level, meal_starts, meals_by_start, walk_starts, walks_by_start = physiology(series, knobs)
        pop_level, pop_meal_starts, pop_meals, pop_walk_starts, pop_walks = physiology(series, pop)
        errors: dict[int, list[float]] = {30: [], 60: [], 120: []}
        cal_rows: dict[int, list[dict[str, float]]] = {30: [], 60: [], 120: []}
        for index, day in enumerate(series["dayIndex"]):
            if day < 4 or day >= 6 or index % 6:
                continue
            current = glucose_at(series, index)
            if current is None:
                continue
            lag = glucose_at(series, index - 6)
            slope = 0.0 if lag is None else (current - lag) / 30
            for horizon in (30, 60, 120):
                steps = horizon // STEP
                actual = glucose_at(series, index + steps)
                preds = curve_p50(index, steps, current, level, meal_starts, meals_by_start, walk_starts, walks_by_start, knobs["tauMin"], knobs.get("mealResidual") == "scaled")
                if actual is None or preds is None:
                    continue
                errors[horizon].append(actual - preds[-1])
                cal_rows[horizon].append({"pred": preds[-1], "actual": actual, "slope": slope})
        # Finite-sample split-conformal band on the raw twin (alerts use it).
        bands: dict[int, dict[str, float]] = {horizon: conformal_band(bucket) for horizon, bucket in errors.items()}
        person["calRows"] = cal_rows
        person["knobs"] = knobs
        person["isolatedMeals"] = isolated
        person["bands"] = {str(key): value for key, value in bands.items()}
        base = []
        for index, day in enumerate(series["dayIndex"]):
            current = glucose_at(series, index)
            if day < 4 or current is None or series["censored"][index]:
                base.append(None)
                continue
            preds = curve_p50(index, 24, current, level, meal_starts, meals_by_start, walk_starts, walks_by_start, knobs["tauMin"], knobs.get("mealResidual") == "scaled")
            if preds is None:
                base.append(None)
                continue
            points = widen(preds, bands)
            base.append(
                (
                    spike_probability(current, points),
                    # Raw twin low risk; each low-rule candidate applies its own post-meal guard (physics post_meal_guarded).
                    low_probability(current, points),
                    current,
                    glucose_at(series, index - 3),
                    trough_within(points, 30),
                    minutes_since_meal(series["meals"], index * STEP),  # type: ignore[arg-type]
                )
            )
        points = [
            {
                "glucose": None if series["gap"][index] or series["compression"][index] else series["glucose"][index],
                "blocked": bool(series["gap"][index] or series["compression"][index] or series["glucose"][index] is None),
            }
            for index in range(series["bins"])
        ]
        meal_marks = []
        for meal in series["meals"]:
            if not meal["logged"]:
                continue
            meal_index = round(meal["min"] / STEP)
            meal_marks.append({"index": meal_index, "pre": glucose_at(series, meal_index)})
        events = find_glucose_events(points, meal_marks, STEP)
        person["alertInputs"] = {"base": base, "events": events, "bands": bands}
        horizon_rows: dict[int, list[dict[str, float]]] = {30: [], 60: [], 120: []}
        base_rows: dict[str, dict[int, list[dict[str, float]]]] = {
            "persistence": {30: [], 60: [], 120: []},
            "linear": {30: [], 60: [], 120: []},
            "population": {30: [], 60: [], 120: []},
        }
        for index, day in enumerate(series["dayIndex"]):
            if day < 6 or index % 6:
                continue
            current = glucose_at(series, index)
            if current is None:
                continue
            lag = glucose_at(series, index - 6)
            slope = 0.0 if lag is None else (current - lag) / 30
            now = index * STEP
            meals = [meal for meal in series["meals"] if meal["logged"] and meal["min"] <= now]
            cob = 0.0
            for meal in meals:
                remaining = 1 - (now - meal["min"]) / 180
                if remaining > 0:
                    cob += meal["carbs"] * remaining
            last = meals[-1] if meals else None
            clock = series["clockMin"][index]
            hour = clock / 60
            mets_30 = 0.0
            mets_60 = 0.0
            for back in range(0, 12):
                value = series["mets"][index - back] if index - back >= 0 else None
                if value is not None:
                    mets_60 += value
                    if back < 6:
                        mets_30 += value
            preds = curve_p50(index, 24, current, level, meal_starts, meals_by_start, walk_starts, walks_by_start, knobs["tauMin"], knobs.get("mealResidual") == "scaled")
            pop_preds = curve_p50(index, 24, current, pop_level, pop_meal_starts, pop_meals, pop_walk_starts, pop_walks, pop["tauMin"], pop.get("mealResidual") == "scaled")
            if preds is None or pop_preds is None:
                continue
            for horizon in (30, 60, 120):
                steps = horizon // STEP
                actual = glucose_at(series, index + steps)
                if actual is None or steps >= len(preds) or steps >= len(pop_preds):
                    continue
                pred = preds[steps]
                pop_pred = pop_preds[steps]
                width = band_at(horizon, bands)
                p10, p50, p90 = order_quantiles(pred + width["q10"], pred, pred + width["q90"])
                covered = p10 <= actual <= p90
                row = {
                    "err": p50 - actual,
                    "actual": actual,
                    "pred": p50,
                    "covered": covered,
                    "horizon": horizon,
                    "slope": slope,
                    "q10": width["q10"],
                    "q90": width["q90"],
                }
                horizon_rows[horizon].append(row)
                base_rows["persistence"][horizon].append({**row, "err": current - actual, "pred": current, "covered": False})
                linear = current + slope * horizon
                base_rows["linear"][horizon].append({**row, "err": linear - actual, "pred": linear, "covered": False})
                base_rows["population"][horizon].append({**row, "err": pop_pred - actual, "pred": pop_pred, "covered": False})
                feature_rows.append(
                    {
                        "subject": person["subject"],
                        "group": person["group"],
                        "horizon": horizon,
                        "y": actual - p50,
                        "glucose": current,
                        "lag30": 0 if lag is None else lag,
                        "slope30": slope,
                        "cob": cob,
                        "minsMeal": 999 if last is None else now - last["min"],
                        "lastCarbs": 0 if last is None else last["carbs"],
                        "mets30": mets_30,
                        "mets60": mets_60,
                        "sin": math.sin(2 * math.pi * hour / 24),
                        "cos": math.cos(2 * math.pi * hour / 24),
                        "hba1c": person["hba1c"],
                        "bmi": person["bmi"],
                        "fasting": person["fastingGlucose"] or 0,
                        "insulin": person["fastingInsulin"] or 0,
                        "age": person["age"],
                        "sex": 1 if person["sex"] == "F" else 0,
                        "twin": p50,
                        "actual": actual,
                    }
                )
        person["rows"] = horizon_rows
        person["baselines"] = base_rows
        fit60 = metrics_from(horizon_rows[60])
        fit120 = metrics_from(horizon_rows[120])
        pop60 = metrics_from(base_rows["population"][60])
        person["fit"] = {
            "rmse60": fit60["rmse"] or 0,
            "rmse60Pop": pop60["rmse"] or 0,
            "rmse120": fit120["rmse"] or 0,
        }
        stored.append(person)
        print(f"scored {person['id']} days={person['days']} group={person['group']}", flush=True)

    choices, low_rule_rows = lopo_low_rules(stored)
    modal = max(set(choices), key=lambda k: (choices.count(k), -k))
    low_rule = LOW_TREND_RULES[modal]
    print(f"low rule chosen leave-one-participant-out; most frequent: {low_rule} ({choices.count(modal)} of {len(choices)})", flush=True)
    risk_by_person = [risk_rows(person, LOW_TREND_RULES[person["lowRuleIndex"]]) for person in stored]
    discrimination = {
        "spike": _discrimination(
            [rows["spike"] for rows in risk_by_person],
            "Within the next 120 min glucose goes above 180, or rises 50 mg/dL above now (steps at or under 180 now)",
        ),
        "low": _discrimination(
            [rows["low"] for rows in risk_by_person],
            "Within the next 60 min glucose falls under 70 (steps at or over 70 now)",
        ),
    }
    print(f"discrimination: spike AUROC {discrimination['spike']['auroc']}, low AUROC {discrimination['low']['auroc']}", flush=True)
    for person in stored:
        del person["alertInputs"]
    trend = apply_trend_correction(stored)
    ridge = loo_ridge(stored)
    for person, prior in zip(stored, ridge):
        person["ehrKnobs"] = {**prior, "mealClock": meal_clock, "mealResidual": residual_mode}
    # Pre-compute the per-person ehr-personal knobs: choose the trust level
    # between the day's 1-4 personal fit and the leave-one-out ridge prior on
    # validation days 5–6, with the same 1-SE floor as cohort.ts. Mirrors
    # chooseTrust in TypeScript so the ehrPersonal arm here matches the live
    # twin, instead of the older knobs_toward(calibration, ehrKnobs) recipe
    # whose fixed shrinkage was the reason `ehrPersonal` used to trail `ehr`.
    ehr_personal_knobs = {}
    for person in stored:
        picked, _ = choose_trust(person["series"], person["personalFit"], person["ehrKnobs"])
        ehr_personal_knobs[person["id"]] = picked
    ablation = []
    arm_specs = (
        ("none", "No EHR", lambda person: {**global_knobs(), "mealClock": meal_clock, "mealResidual": residual_mode}),
        ("group", "Group only", lambda person: {**POP[str(person["group"])], "mealClock": meal_clock, "mealResidual": residual_mode}),
        ("ehr", "EHR prior", lambda person: person["ehrKnobs"]),
        ("ehrPersonal", "EHR prior + personal calibration", lambda person, _cache=ehr_personal_knobs: {**_cache[person["id"]], "mealClock": meal_clock, "mealResidual": residual_mode}),  # type: ignore[arg-type]
    )
    for arm_id, label, pick in arm_specs:
        sse = 0.0
        count = 0
        for person in stored:
            part_sse, part_n = pooled_sse60(person["series"], pick(person))  # type: ignore[arg-type]
            sse += part_sse
            count += part_n
        ablation.append({"id": arm_id, "label": label, "rmse60": round1(math.sqrt(sse / count) if count else 0), "n": count})
        print(f"ablation {arm_id} rmse60={ablation[-1]['rmse60']} n={count}", flush=True)

    demo_subjects = set()
    for name in ("healthy", "prediabetes", "t2d"):
        members = [person for person in stored if person["group"] == name and person["days"] >= 8]
        if members:
            demo_subjects.add(sorted(members, key=lambda person: person["subject"])[-1]["subject"])

    frame = pd.DataFrame(feature_rows)
    train = frame[~frame["subject"].isin(demo_subjects)] if not frame.empty else frame
    hybrid = {}
    feature_cols = ["glucose", "lag30", "slope30", "cob", "minsMeal", "lastCarbs", "mets30", "mets60", "sin", "cos", "hba1c", "bmi", "fasting", "insulin", "age", "sex"]
    heldout_models = {}
    for horizon in (30, 60, 120):
        part = train[train["horizon"] == horizon] if not train.empty else train
        demo_part = frame[(frame["horizon"] == horizon) & (frame["subject"].isin(demo_subjects))] if not frame.empty else frame
        if part.empty:
            hybrid[str(horizon)] = {"kept": False, "rmseTwin": None, "rmseHybrid": None, "heldoutTwin": None, "heldoutHybrid": None}
            continue
        x = part[feature_cols].to_numpy()
        y = part["y"].to_numpy()
        groups = part["subject"].to_numpy()
        pred_residual = np.zeros(len(part))
        splits = min(5, len(set(groups)))
        if splits < 2:
            hybrid[str(horizon)] = {"kept": False, "rmseTwin": None, "rmseHybrid": None, "heldoutTwin": None, "heldoutHybrid": None}
            continue
        splitter = GroupKFold(n_splits=splits)
        for train_idx, test_idx in splitter.split(x, y, groups):
            model = lgb.LGBMRegressor(
                n_estimators=80,
                learning_rate=0.08,
                num_leaves=15,
                min_child_samples=20,
                subsample=0.9,
                random_state=42,
                verbose=-1,
            )
            model.fit(x[train_idx], y[train_idx])
            pred_residual[test_idx] = model.predict(x[test_idx])
        twin = part["twin"].to_numpy()
        actual = part["actual"].to_numpy()
        hybrid_pred = twin + pred_residual
        rmse_twin = float(np.sqrt(np.mean((twin - actual) ** 2)))
        rmse_hybrid = float(np.sqrt(np.mean((hybrid_pred - actual) ** 2)))
        kept = rmse_hybrid + 1e-9 < rmse_twin
        held_twin = None
        held_hybrid = None
        if not demo_part.empty:
            final = lgb.LGBMRegressor(
                n_estimators=80,
                learning_rate=0.08,
                num_leaves=15,
                min_child_samples=20,
                subsample=0.9,
                random_state=42,
                verbose=-1,
            )
            final.fit(x, y)
            heldout_models[horizon] = final
            demo_x = demo_part[feature_cols].to_numpy()
            demo_twin = demo_part["twin"].to_numpy()
            demo_actual = demo_part["actual"].to_numpy()
            demo_hybrid = demo_twin + final.predict(demo_x)
            held_twin = round1(float(np.sqrt(np.mean((demo_twin - demo_actual) ** 2))))
            held_hybrid = round1(float(np.sqrt(np.mean((demo_hybrid - demo_actual) ** 2))))
        hybrid[str(horizon)] = {
            "kept": kept,
            "rmseTwin": round1(rmse_twin),
            "rmseHybrid": round1(rmse_hybrid),
            "heldoutTwin": held_twin,
            "heldoutHybrid": held_hybrid,
            "cvParticipants": int(len(set(groups))),
            "heldoutParticipants": int(demo_part["subject"].nunique()) if not demo_part.empty else 0,
        }

    def pooled(key: str, horizon: int) -> list[dict[str, float]]:
        rows = []
        for person in stored:
            bucket = person["rows"][horizon] if key == "twin" else person["baselines"][key][horizon]
            rows.extend(bucket)
        return rows

    rng = random.Random(42)
    horizons = []
    for horizon in (30, 60, 120):
        twin_rows = pooled("twin", horizon)
        pers_rows = pooled("persistence", horizon)
        pop_rows = pooled("population", horizon)
        lin_rows = pooled("linear", horizon)
        twin = metrics_from(twin_rows)
        pers = metrics_from(pers_rows)
        pop = metrics_from(pop_rows)
        lin = metrics_from(lin_rows)
        patient_rmse = []
        for person in stored:
            bucket = person["rows"][horizon]
            if bucket:
                sse = sum(item["err"] ** 2 for item in bucket)
                patient_rmse.append(math.sqrt(sse / len(bucket)))
        pers_rmse = pers["rmse"] or 0
        twin_rmse = twin["rmse"] or 0
        horizons.append(
            {
                "horizonMin": horizon,
                "rmseTwin": twin_rmse,
                "rmsePersistence": pers_rmse,
                "rmsePopulation": pop["rmse"] or 0,
                "rmseLinear": lin["rmse"] or 0,
                "improvementPct": round1(((pers_rmse - twin_rmse) / pers_rmse) * 100) if pers_rmse else 0,
                "mae": twin["mae"] or 0,
                "mard": twin["mard"] or 0,
                "coverage": twin["coverage"] or 0,
                "clarkeApb": twin["clarkeApb"] if horizon == 30 else None,
                "n": twin["n"],
                "patientRmseMean": round1(sum(patient_rmse) / len(patient_rmse)) if patient_rmse else 0,
                "patientRmseCi": bootstrap_ci(patient_rmse, rng),
            }
        )

    groups = []
    for name in ("t2d", "prediabetes", "healthy"):
        members = [person for person in stored if person["group"] == name]
        rows = []
        pers = []
        for person in members:
            rows.extend(person["rows"][60])
            pers.extend(person["baselines"]["persistence"][60])
        summary = metrics_from(rows)
        pers_summary = metrics_from(pers)
        twin_rmse = summary["rmse"] or 0
        pers_rmse = pers_summary["rmse"] or 0
        groups.append(
            {
                "group": name,
                "patients": len(members),
                "rmse60": twin_rmse,
                "rmse60Persistence": pers_rmse,
                "improvementPct": round1(((pers_rmse - twin_rmse) / pers_rmse) * 100) if pers_rmse else 0,
            }
        )

    def alert_totals() -> dict[str, object]:
        spike_events = sum(person["alertScore"]["spikeEvents"] for person in stored)
        low_events = sum(person["alertScore"]["lowEvents"] for person in stored)
        spike_alerts = sum(person["alertScore"]["spikeAlerts"] for person in stored)
        low_alerts = sum(person["alertScore"]["lowAlerts"] for person in stored)
        spike_hits = sum(person["alertScore"]["spikeHits"] for person in stored)
        low_hits = sum(person["alertScore"]["lowHits"] for person in stored)
        spike_false = sum(person["alertScore"]["spikeFalse"] for person in stored)
        low_false = sum(person["alertScore"]["lowFalse"] for person in stored)
        leads = []
        for person in stored:
            leads.extend(person["alertScore"]["spikeLeads"])
        leads.sort()
        eval_days = sum(max(0, person["days"] - 6) for person in stored)
        # Spike lead-time shares at 30 and 60 minute cutoffs. "count" is the
        # number of matching hits whose lead was at least the cutoff; "events"
        # is the total pool of spike events (matching or missed). A miss has no
        # lead and so cannot contribute to either share.
        spike_at_least_30 = sum(1 for lead in leads if lead >= 30)
        spike_at_least_60 = sum(1 for lead in leads if lead >= 60)
        spike_at_least_120 = sum(1 for lead in leads if lead >= 120)
        return {
            "spikeEvents": spike_events,
            "lowEvents": low_events,
            "spikeAlerts": spike_alerts,
            "lowAlerts": low_alerts,
            "spikeRecall": None if not spike_events else round(spike_hits / spike_events, 3),
            "spikePrecision": None if not spike_alerts else round((spike_alerts - spike_false) / spike_alerts, 3),
            "lowRecall": None if not low_events else round(low_hits / low_events, 3),
            "lowPrecision": None if not low_alerts else round((low_alerts - low_false) / low_alerts, 3),
            "falsePerPatientDay": round((spike_false + low_false) / max(1, eval_days), 2),
            "medianLeadMin": None if not leads else round(quantile(leads, 0.5)),
            "leadIqrMin": None if not leads else [round(quantile(leads, 0.25)), round(quantile(leads, 0.75))],
            "evalDays": eval_days,
            "spikeHits": spike_hits,
            "spikeTrue": spike_alerts - spike_false,
            "lowHits": low_hits,
            "lowTrue": low_alerts - low_false,
            "spikeLeadShares": {
                "atLeast30": {
                    "count": spike_at_least_30,
                    "events": spike_events,
                    "share": round(spike_at_least_30 / spike_events, 3) if spike_events else 0,
                },
                "atLeast60": {
                    "count": spike_at_least_60,
                    "events": spike_events,
                    "share": round(spike_at_least_60 / spike_events, 3) if spike_events else 0,
                },
                "atLeast120": {
                    "count": spike_at_least_120,
                    "events": spike_events,
                    "share": round(spike_at_least_120 / spike_events, 3) if spike_events else 0,
                },
            },
            "discrimination": discrimination,
            # Participant-level bootstrap 95% confidence interval on the twin's
            # RMSE reduction vs. persistence at the 60-min and 120-min horizons.
            # 1,000 resamples of the participant set with replacement;
            # intervals are the 2.5 / 97.5 percentiles of the per-resample
            # reduction, expressed as a fraction of the persistence baseline.
            "bootstrapRmseReduction": _bootstrap_rmse_reduction(stored),
        }


    demo = []
    for name in ("healthy", "prediabetes", "t2d"):
        members = [person for person in stored if person["group"] == name and person["subject"] in demo_subjects]
        if not members:
            continue
        chosen = members[0]
        series = chosen["series"]
        demo.append(
            {
                "patient": {
                    key: chosen[key]
                    for key in (
                        "id",
                        "subject",
                        "age",
                        "sex",
                        "bmi",
                        "weightKg",
                        "heightCm",
                        "hba1c",
                        "fastingGlucose",
                        "fastingInsulin",
                        "homaIr",
                        "triglycerides",
                        "hdl",
                        "ldl",
                        "group",
                    )
                },
                "origin": series["origin"],
                "libreOffset": series["libreOffset"],
                "knobs": chosen["knobs"],
                "ehrKnobs": chosen["ehrKnobs"],
                "calibration": chosen["calibration"],
                "isolatedMeals": chosen["isolatedMeals"],
                "personalTrust": chosen["personalTrust"],
                "bands": chosen["bands"],
                "trend": chosen["trend"],
                "trendBands": chosen["trendBands"],
                "fit": chosen["fit"],
                "glucose": series["glucose"],
                "hr": series["hr"],
                "mets": series["mets"],
                "gap": series["gap"],
                "censored": series["censored"],
                "compression": series["compression"],
                "worn": series["worn"],
                "meals": series["meals"],
                "walks": series["walks"],
                "dayIndex": series["dayIndex"],
            }
        )

    alerts = alert_totals()
    real_eval = {
        "dataset": "CGMacros",
        "version": "1.0.0",
        "doi": "10.13026/3z8q-x658",
        "licence": "CC BY-NC-SA 4.0",
        "participants": len(stored),
        "skippedSubjects": skipped,
        "demoSubjects": sorted(demo_subjects),
        "groupCounts": {name: sum(1 for person in stored if person["group"] == name) for name in ("healthy", "prediabetes", "t2d")},
        "horizons": horizons,
        "groups": groups,
        "trendCorrection": trend,
        "personalTrust": {
            "chosenOn": "validation days 5–6, per participant, 1-SE floor to the group prior anchored at the measured overnight fasting level (cohort.ts chooseTrust)",
            "counts": {str(level): sum(1 for person in stored if person["personalTrust"] == level) for level in TRUST_STEPS},
        },
        "mealResidual": {
            "chosen": residual_mode,
            "chosenOn": "validation days 5–6, pooled 60-min RMSE of the personal twin",
            "validationRmse60": residual_rmse,
        },
        "mealClock": {
            "chosen": meal_clock,
            "chosenOn": "validation days 5–6, pooled 60-min RMSE of the personal twin",
            "validationRmse60": meal_clock_rmse,
        },
        "alerts": alerts,
        "lowRule": {
            "chosen": low_rule,
            "chosenOn": "leave-one-participant-out on test days (day 7 on): each participant is scored with the candidate that had the best pooled low-alert F1 on the other participants; the dashboard uses the most frequent choice",
            "selection": "leave-one-participant-out",
            "choiceCounts": {str(k): choices.count(k) for k in sorted(set(choices))},
            "candidates": low_rule_rows,
        },
        "hybrid": hybrid,
        "ablation": ablation,
        "note": "Days 1–4 set the knobs, days 5–6 set the conformal band (finite-sample split conformal, refit after the leave-one-participant-out trend correction), day 7 through the end of each file is the test. Dexcom is primary. Libre fills gaps after a per-person median offset. Watch walks (METs ≥ 3 for ≥ 10 min) are fed to the forecaster. No sleep stream exists in CGMacros. The three demo participants are held out of the LightGBM fit. The EHR prior is a leave-one-out ridge on HbA1c, fasting glucose, fasting insulin, HOMA-IR, BMI, age, and sex.",
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "real_eval.json").write_text(json.dumps(json_ready(real_eval), indent=2) + "\n", encoding="utf-8", newline="\n")
    (OUT_DIR / "demo_patients.json").write_text(json.dumps(json_ready({"patients": demo})), encoding="utf-8", newline="\n")
    attribution = """# CGMacros attribution

The real-data cohort is derived from CGMacros version 1.0.0 on PhysioNet.

- Authors: Anurag Das, David Kerr, Namino Glanz, Wendy Bevier, Rony Santiago, Ricardo Gutierrez-Osuna, Bobak Mortazavi
- DOI: [10.13026/3z8q-x658](https://doi.org/10.13026/3z8q-x658)
- Licence: CC BY-NC-SA 4.0
- Raw CSVs are not in this repository. `ml/download_cgmacros.sh` fetches them into a local directory.

`src/lib/glucotwin/real/real_eval.json` and `demo_patients.json` are computed derivatives: a 5-minute grid, meal macros scaled by amount consumed, and walk bouts from METs. They are not a copy of the source files.

Research prototype — not a medical device, not medical advice.
"""
    (OUT_DIR / "ATTRIBUTION.md").write_text(attribution, encoding="utf-8", newline="\n")
    lines = [
        "",
        "## CGMacros — real files, days 7 through the end",
        "",
        "Printed by `ml/evaluate_cgmacros.py`. Not the simulated cohort. RMSE is mg/dL.",
        "",
        "| Horizon | Twin RMSE | Persistence | Population | 30-min linear | Vs persistence | Coverage | Clarke A+B |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for row in horizons:
        clarke = "—" if row["clarkeApb"] is None else row["clarkeApb"]
        lines.append(
            f"| {row['horizonMin']} | {row['rmseTwin']} | {row['rmsePersistence']} | {row['rmsePopulation']} | {row['rmseLinear']} | {row['improvementPct']}% | {row['coverage']} | {clarke} |"
        )
    lines.append("")
    lines.append("| Group | Patients | 60-min RMSE | Persistence | Improvement |")
    lines.append("|---|---|---|---|---|")
    for group in groups:
        lines.append(
            f"| {group['group']} | {group['patients']} | {group['rmse60']} | {group['rmse60Persistence']} | {group['improvementPct']}% |"
        )
    lines.append("")
    lines.append(
        f"Participants {len(stored)}. Spike events {alerts['spikeEvents']}, alerts {alerts['spikeAlerts']}, recall {alerts['spikeRecall']}, precision {alerts['spikePrecision']}. "
        f"Low events {alerts['lowEvents']}, alerts {alerts['lowAlerts']}, recall {alerts['lowRecall']}, precision {alerts['lowPrecision']}. "
        f"False alerts {alerts['falsePerPatientDay']} per patient-day. Median lead {alerts['medianLeadMin']} min, IQR {alerts['leadIqrMin']}."
    )
    lines.append("")
    for horizon, row in hybrid.items():
        lines.append(
            f"Hybrid +{horizon} min: kept {row['kept']}. Cross-validated twin {row['rmseTwin']} vs hybrid {row['rmseHybrid']}. "
            f"Held-out 3: twin {row['heldoutTwin']} vs hybrid {row['heldoutHybrid']}."
        )
    lines.append("")
    lines.append("Cold start, 60-min RMSE, same test days. Ridge is leave-one-out. Personal calibration shrinks the day 1–4 estimate toward that ridge prior.")
    lines.append("")
    lines.append("| Arm | 60-min RMSE | Points |")
    lines.append("|---|---|---|")
    for arm in ablation:
        lines.append(f"| {arm['label']} | {arm['rmse60']} | {arm['n']} |")
    lines.append("")
    lines.append(
        f"Wilson numerators: spike hits {alerts['spikeHits']} of {alerts['spikeEvents']} events, "
        f"spike true alerts {alerts['spikeTrue']} of {alerts['spikeAlerts']}, "
        f"low hits {alerts['lowHits']} of {alerts['lowEvents']}, low true alerts {alerts['lowTrue']} of {alerts['lowAlerts']}."
    )
    lines.append("")
    block = "\n".join(lines)
    changelog = ROOT / "docs" / "CHANGELOG_EVAL.md"
    previous = changelog.read_text(encoding="utf-8") if changelog.exists() else "# Evaluation changelog\n"
    start = "<!-- CGMACROS_EVAL_START -->"
    end = "<!-- CGMACROS_EVAL_END -->"
    section = f"{start}\n{block}\n{end}\n"
    if start in previous and end in previous:
        previous = previous[: previous.index(start)] + section + previous[previous.index(end) + len(end) :]
        changelog.write_text(previous if previous.endswith("\n") else previous + "\n", encoding="utf-8", newline="\n")
    else:
        changelog.write_text(previous.rstrip() + "\n\n" + section, encoding="utf-8", newline="\n")
    print(json.dumps(json_ready({"participants": len(stored), "horizons": horizons, "alerts": alerts, "hybrid": hybrid, "groups": groups, "demo": sorted(demo_subjects)}), indent=2))


if __name__ == "__main__":
    main()
