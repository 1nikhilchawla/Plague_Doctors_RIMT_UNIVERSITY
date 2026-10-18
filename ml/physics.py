"""Port of src/lib/glucotwin/physics.ts. Keep the arithmetic identical."""

from __future__ import annotations

import math
from typing import Any

GLUCOSE_MIN = 40.0
GLUCOSE_MAX = 400.0
STEP_MIN = 5


def clip_glucose(value: float) -> float:
    if not math.isfinite(value):
        return GLUCOSE_MIN
    return min(GLUCOSE_MAX, max(GLUCOSE_MIN, value))


def order_quantiles(a: float, b: float, c: float) -> list[float]:
    sorted_values = sorted([a, b, c])
    return [clip_glucose(value) for value in sorted_values]


def minute_of_day(abs_min: float) -> float:
    day = 1440
    return ((abs_min % day) + day) % day


def dawn_rise(abs_min: float, dawn_amp: float) -> float:
    hour = minute_of_day(abs_min) / 60
    if hour < 4 or hour > 9:
        return 0.0
    return dawn_amp * math.sin(math.pi * ((hour - 4) / 5))


def circadian(abs_min: float, dawn_amp: float, baseline: float) -> float:
    hour = minute_of_day(abs_min) / 60
    diurnal = 3.5 * math.sin(((hour - 9) / 24) * math.pi * 2)
    return baseline + dawn_rise(abs_min, dawn_amp) + diurnal


def meal_shape(delay_min: float, fiber_frac: float) -> tuple[float, float]:
    if delay_min < 0 or delay_min >= 180:
        return 0.0, 1.0
    clamped = min(0.45, max(0.0, fiber_frac))
    peak_at = 45 + clamped * 50
    shape = delay_min / peak_at if delay_min <= peak_at else (180 - delay_min) / (180 - peak_at)
    return shape, 1 - 0.35 * clamped


def meal_time_factor(meal_min: float) -> float:
    hour = minute_of_day(meal_min) / 60
    dawn = 0.1 * math.sin(math.pi * ((hour - 4) / 5)) if 4 <= hour <= 9 else 0.0
    return 1 + 0.14 * math.sin((2 * math.pi * (hour - 14)) / 24) + dawn


def meal_size_factor(carbs: float) -> float:
    return 1 + 0.003 * max(0.0, carbs - 40)


def meal_offset(delay_min: float, carbs: float, fiber: float, sens_per_10g: float, meal_min: float | None = None) -> float:
    if carbs <= 0 or delay_min < 0:
        return 0.0
    shape, atten = meal_shape(delay_min, fiber / carbs)
    clock = 1.0 if meal_min is None else meal_time_factor(meal_min) * meal_size_factor(carbs)
    return ((sens_per_10g * carbs) / 10) * atten * shape * clock


def meal_clock_min(meal: dict[str, Any], knobs: dict[str, Any]) -> float | None:
    return None if knobs.get("mealClock", True) is False else meal["min"]


def walk_offset(delay_min: float, duration_min: float, effect_per_30: float) -> float:
    if duration_min <= 0 or delay_min < 0 or effect_per_30 == 0:
        return 0.0
    full = effect_per_30 * (duration_min / 30)
    end = duration_min
    hold = end + 15
    recover = end + 75
    if delay_min >= recover:
        return 0.0
    if delay_min <= end:
        return -full * (delay_min / max(end, 1))
    if delay_min <= hold:
        return -full
    return -full * ((recover - delay_min) / (recover - hold))


def offset_at(abs_min: float, meals: list[dict[str, Any]], walks: list[dict[str, Any]], knobs: dict[str, float]) -> float:
    total = 0.0
    for meal in meals:
        delay = abs_min - meal["min"]
        if delay < 0 or delay > 180:
            continue
        total += meal_offset(delay, meal["carbs"], meal["fiber"], knobs["carbSensitivity"], meal_clock_min(meal, knobs))
    for walk in walks:
        delay = abs_min - walk["min"]
        if delay < 0 or delay > walk["durationMin"] + 75:
            continue
        total += walk_offset(delay, walk["durationMin"], knobs["activityEffect"])
    return total


def forecast_curve(payload: dict[str, Any]) -> list[dict[str, float]]:
    horizon = payload.get("horizonMin", 120)
    knobs = payload["knobs"]
    now = payload["nowMin"]
    base_now = circadian(now, knobs["dawnAmp"], knobs["fastingBaseline"])
    off_now = offset_at(now, payload["meals"], payload["walks"], knobs)
    residual = payload["glucoseNow"] - base_now - off_now
    # Meal-scaled negative residual, as physics.ts forecastCurve.
    started = [meal for meal in payload["meals"] if meal["min"] <= now]
    meal_now = offset_at(now, started, [], knobs)
    scaled = knobs.get("mealResidual") == "scaled"
    meal_residual = max(residual, -meal_now) if scaled and meal_now > 0 and residual < 0 else 0.0
    meal_scale = (meal_now + meal_residual) / meal_now if meal_now > 0 else 1.0
    points: list[dict[str, float]] = []
    steps = round(horizon / STEP_MIN)
    band = payload["band"]
    for step in range(steps + 1):
        ahead = step * STEP_MIN
        abs_min = now + ahead
        decay = math.exp(-ahead / max(30, knobs["tauMin"]))
        started_later = offset_at(abs_min, started, [], knobs) if meal_residual else 0.0
        pred = (
            circadian(abs_min, knobs["dawnAmp"], knobs["fastingBaseline"])
            + offset_at(abs_min, payload["meals"], payload["walks"], knobs)
            - (1 - meal_scale) * started_later
            + (residual - meal_residual) * decay
        )
        widen = min(1, ahead / 30)
        p10, p50, p90 = order_quantiles(pred + band["q10"] * widen, pred, pred + band["q90"] * widen)
        points.append({"minutesAhead": ahead, "p10": p10, "p50": p50, "p90": p90})
    return points


def normal_cdf(z: float) -> float:
    sign = -1 if z < 0 else 1
    x = abs(z) / math.sqrt(2)
    a1 = 0.254829592
    a2 = -0.284496736
    a3 = 1.421413741
    a4 = -1.453152027
    a5 = 1.061405429
    p = 0.3275911
    t = 1 / (1 + p * x)
    erf = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * math.exp(-x * x)
    return 0.5 * (1 + sign * erf)


def spike_probability(current: float, points: list[dict[str, float]]) -> float:
    if current > 180:
        return 0.0
    peak = points[0]["p50"] if points else current
    width = 8.0
    for point in points:
        if point["minutesAhead"] > 120:
            break
        if point["p50"] >= peak:
            peak = point["p50"]
            width = max(6, (point["p90"] - point["p10"]) / 2.563)
    p_high = 1 - normal_cdf((180 - peak) / width)
    p_rise = 1 - normal_cdf((current + 50 - peak) / width)
    return min(0.99, max(0.0, max(p_high, p_rise)))


def hygiene_fires(samples: list[dict[str, Any]], suppression_steps: int = 12, daily_cap: int = 8) -> list[str | None]:
    fires: list[str | None] = []
    spike_on = False
    low_on = False
    spike_hold = -1e9
    low_hold = -1e9
    fires_today = 0
    day = samples[0]["day"] if samples else 0
    for index, sample in enumerate(samples):
        if sample["day"] != day:
            day = sample["day"]
            fires_today = 0
        if spike_on and sample["spike"] < 0.4:
            spike_on = False
        if low_on and sample["low"] < 0.4:
            low_on = False
        if sample["gap"] or fires_today >= daily_cap:
            fires.append(None)
            continue
        low_ready = (not low_on) and sample["low"] >= 0.6 and index >= low_hold
        spike_ready = (not spike_on) and sample["spike"] >= 0.6 and index >= spike_hold and sample["low"] < 0.6
        if low_ready:
            low_on = True
            low_hold = index + suppression_steps
            fires_today += 1
            fires.append("low")
            continue
        if spike_ready:
            spike_on = True
            spike_hold = index + suppression_steps
            fires_today += 1
            fires.append("spike")
            continue
        fires.append(None)
    return fires


def clarke_zone(reference: float, prediction: float) -> str:
    y = reference
    yp = prediction
    if (yp <= 70 and y <= 70) or (yp <= 1.2 * y and yp >= 0.8 * y):
        return "A"
    if (y >= 180 and yp <= 70) or (y <= 70 and yp >= 180):
        return "E"
    if (y >= 70 and y <= 290 and yp >= y + 110) or (y >= 130 and y <= 180 and yp <= (7 / 5) * y - 182):
        return "C"
    if (
        (y >= 240 and yp >= 70 and yp <= 180)
        or (y <= 175 / 3 and yp <= 180 and yp >= 70)
        or (y >= 175 / 3 and y <= 70 and yp >= (6 / 5) * y)
    ):
        return "D"
    return "B"


def find_glucose_events(
    points: list[dict[str, Any]],
    meals: list[dict[str, Any]],
    step_min: int = STEP_MIN,
) -> dict[str, list[int]]:
    below_need = round(60 / step_min)
    above_need = round(30 / step_min)
    rise_steps = round(120 / step_min)
    dedupe_steps = round(180 / step_min)
    spike_at: list[int] = []
    below_run = 0
    above_run = 0
    lows: list[int] = []
    for index, sample in enumerate(points):
        if sample["blocked"] or sample["glucose"] is None:
            below_run = 0
            above_run = 0
            continue
        if sample["glucose"] <= 180:
            below_run += 1
        else:
            if below_run >= below_need:
                spike_at.append(index)
            below_run = 0
        if sample["glucose"] >= 70:
            above_run += 1
        else:
            if above_run >= above_need:
                lows.append(index)
            above_run = 0
    for meal in meals:
        if meal["pre"] is None:
            continue
        last = min(len(points) - 1, meal["index"] + rise_steps)
        for index in range(meal["index"] + 1, last + 1):
            sample = points[index]
            if not sample or sample["blocked"] or sample["glucose"] is None:
                continue
            if sample["glucose"] >= meal["pre"] + 50:
                spike_at.append(index)
                break
    spike_at.sort()
    spikes: list[int] = []
    last_spike = -1e9
    for index in spike_at:
        if index - last_spike < dedupe_steps:
            continue
        spikes.append(index)
        last_spike = index
    return {"spikes": spikes, "lows": lows}


def score_alert_events(
    spikes: list[int],
    lows: list[int],
    alerts: list[dict[str, Any]],
    step_min: int = STEP_MIN,
) -> dict[str, Any]:
    spike_window = round(120 / step_min)
    low_window = round(60 / step_min)
    leads: list[float] = []
    spike_hits = 0
    low_hits = 0
    for event in spikes:
        prior = [alert for alert in alerts if alert["kind"] == "spike" and event - spike_window <= alert["index"] < event]
        if not prior:
            continue
        spike_hits += 1
        first = min(alert["index"] for alert in prior)
        leads.append((event - first) * step_min)
    for event in lows:
        prior = [alert for alert in alerts if alert["kind"] == "low" and event - low_window <= alert["index"] < event]
        if not prior:
            continue
        low_hits += 1
        first = min(alert["index"] for alert in prior)
        leads.append((event - first) * step_min)
    spike_alerts = [alert for alert in alerts if alert["kind"] == "spike"]
    low_alerts = [alert for alert in alerts if alert["kind"] == "low"]

    def is_false(alert: dict[str, Any], events: list[int], follow: int) -> bool:
        return not any(alert["index"] < event <= alert["index"] + follow for event in events)

    return {
        "spikeEvents": len(spikes),
        "lowEvents": len(lows),
        "spikeAlerts": len(spike_alerts),
        "lowAlerts": len(low_alerts),
        "spikeHits": spike_hits,
        "lowHits": low_hits,
        "spikeFalse": sum(1 for alert in spike_alerts if is_false(alert, spikes, spike_window)),
        "lowFalse": sum(1 for alert in low_alerts if is_false(alert, lows, low_window)),
        "leads": leads,
    }


def quantile(sorted_values: list[float], p: float) -> float:
    if not sorted_values:
        return 0.0
    idx = (len(sorted_values) - 1) * p
    lo = math.floor(idx)
    hi = math.ceil(idx)
    if lo == hi:
        return sorted_values[lo]
    return sorted_values[lo] * (hi - idx) + sorted_values[hi] * (idx - lo)


def post_walk_sensitivity(abs_min: float, walks: list[dict[str, Any]]) -> float:
    factor = 1.0
    for walk in walks:
        end = walk["min"] + walk["durationMin"]
        hours = min(30.0, 12 + walk["durationMin"] / 4)
        span = hours * 60
        if abs_min < end or abs_min >= end + span:
            continue
        fade = 1 - (abs_min - end) / span
        factor *= 1 - 0.28 * fade
    return factor


SLEEP_CARRY = 0.5


def _night_load(night: dict[str, float], rmssd_baseline: float) -> tuple[float, float, float]:
    debt = min(4.0, max(0.0, 7 - night["sleepH"]))
    poor_eff = min(0.3, max(0.0, 0.9 - night["efficiency"])) if night["efficiency"] > 0 else 0.0
    if night["rmssd"] > 0 and rmssd_baseline > 0:
        hrv_drop = min(0.5, max(0.0, (rmssd_baseline - night["rmssd"]) / rmssd_baseline))
    else:
        hrv_drop = 0.0
    return debt, poor_eff, hrv_drop


def _carried_load(night: dict[str, float], rmssd_baseline: float, previous: dict[str, float] | None) -> tuple[float, float, float]:
    debt, poor_eff, hrv_drop = _night_load(night, rmssd_baseline)
    if previous is None:
        return debt, poor_eff, hrv_drop
    b_debt, b_eff, b_hrv = _night_load(previous, rmssd_baseline)
    return debt + SLEEP_CARRY * b_debt, poor_eff + SLEEP_CARRY * b_eff, hrv_drop + SLEEP_CARRY * b_hrv


def wearable_sensitivity(night: dict[str, float], rmssd_baseline: float, previous: dict[str, float] | None = None) -> float:
    debt, poor_eff, hrv_drop = _carried_load(night, rmssd_baseline, previous)
    return 1 + 0.08 * debt + 0.4 * poor_eff + 0.4 * hrv_drop


def wearable_dawn(night: dict[str, float], rmssd_baseline: float, previous: dict[str, float] | None = None) -> float:
    debt, _, hrv_drop = _carried_load(night, rmssd_baseline, previous)
    return 1 + 0.12 * debt + 0.5 * hrv_drop


def conformal_band(errors: list[float]) -> dict[str, float]:
    """Split-conformal 10th-90th band, finite-sample: order statistics floor((n+1)*0.1) and ceil((n+1)*0.9)."""
    if len(errors) < 20:
        return {"q10": -18.0, "q90": 18.0}
    ordered = sorted(errors)
    n = len(ordered)
    lo = max(1, math.floor((n + 1) * 0.1))
    hi = min(n, math.ceil((n + 1) * 0.9))
    return {"q10": ordered[lo - 1], "q90": ordered[hi - 1]}


def post_meal_guarded(current: float, since: float | None, ceiling: float | None, drug_active: bool = False) -> bool:
    """True when twinLowRisk's post-meal guard zeroes the twin's low risk."""
    post_meal = since is not None and since <= 120
    return ceiling is not None and post_meal and current > ceiling and not drug_active


def twin_low_risk(current: float, points: list[dict[str, float]], context: dict[str, Any]) -> float:
    """physics.ts twinLowRisk: no low risk above the post-meal ceiling (default 92 mg/dL, None = off)
    within 120 min of a meal unless a drug is active."""
    ceiling = context["postMealCeiling"] if "postMealCeiling" in context else 92
    if post_meal_guarded(current, context.get("minutesSinceMeal"), ceiling, context.get("drugActive", False)):
        return 0.0
    return low_probability(current, points)


def low_probability(current: float, points: list[dict[str, float]]) -> float:
    if current < 70:
        return 0.0
    trough = points[0]["p50"] if points else current
    width = 8.0
    for point in points:
        if point["minutesAhead"] > 60:
            break
        if point["p50"] <= trough:
            trough = point["p50"]
            width = max(6, (point["p90"] - point["p10"]) / 2.563)
    return min(0.99, max(0.0, normal_cdf((70 - trough) / width)))


def trough_within(points: list[dict[str, float]], minutes: float) -> float | None:
    trough: float | None = None
    for point in points:
        if point["minutesAhead"] > minutes:
            break
        trough = point["p50"] if trough is None else min(trough, point["p50"])
    return trough


def trend_low_risk(current: float, earlier: float | None, rule: dict[str, float] | None, context: dict[str, float | None] | None = None) -> float:
    if rule is None or earlier is None or current < 70:
        return 0.0
    context = context or {"twinTrough30": None, "minutesSinceMeal": None}
    since = context.get("minutesSinceMeal")
    fasting = since is None or since > 120
    if not (current <= rule.get("ceiling", 88) or (fasting and current <= rule.get("ceilingFasting", 95))):
        return 0.0
    rate = (current - earlier) / 15
    if rate > rule["fallRate"]:
        return 0.0
    damped = current + rate * rule["dampMin"] * (1 - math.exp(-rule["aheadMin"] / rule["dampMin"]))
    trough = context.get("twinTrough30")
    projected = damped if trough is None else (1 - rule["blend"]) * damped + rule["blend"] * trough
    return 0.7 if projected < 70 else 0.0
