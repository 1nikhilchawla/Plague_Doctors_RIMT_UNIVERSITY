/**
 * Lifestyle plans the twin can rank. No medicine dosing.
 * Scores use the fitted twin (twinLevel), not the hidden generator: the
 * fitted knobs with each night's sleep and HRV, post-walk sensitivity, the
 * meal clock and size factors, and the medication term from the record. So a
 * plan that moves a meal, splits it or adds a walk changes time in range and
 * the mean, not only the peak.
 *
 * Each plan edits the patient's highest-risk meal slot (breakfast, lunch or
 * dinner): the slot whose meals keep the fitted twin above 180 the longest in
 * the scored week, or, when no meal crosses 180, the slot with the highest
 * post-meal peak. Plans fixed to dinner left patients whose excursions come
 * at lunch with identical rows.
 */

import { POP, twinLevel, type Group, type Meal, type PatientModel, type Walk } from "./cohort.ts";
import { slotHi } from "./i18n.ts";
import { FOODS, sumMacros } from "./foods.ts";
import { STEP_MIN, type MacroEvent, type WalkEvent } from "./physics.ts";

export type PlanId =
  | "as-logged"
  | "walk-after-meal"
  | "protein-swap"
  | "earlier-meal"
  | "split-meal"
  | "jowar-roti"
  | "fasting-day";

export type MealSlot = "breakfast" | "lunch" | "dinner";

export type PlanScore = {
  id: PlanId;
  label: string;
  tirPct: number;
  above180Min: number;
  below70Min: number;
  meanGlucose: number;
  note: string;
  /** One sentence on what in this patient's twin moved the result; empty when nothing patient-specific did. */
  why: string;
  /** The same sentence in Hindi. */
  whyHi: string;
};

const WEEK_DAYS = [9, 10, 11, 12, 13, 14, 15];
export const FASTING_PRESET_DAY = 12;
const AFTER_MEAL_MIN = 180;

export function slotOf(meal: { min: number }): MealSlot {
  const clock = ((meal.min % 1440) + 1440) % 1440;
  if (clock < 11 * 60) return "breakfast";
  if (clock < 16 * 60) return "lunch";
  return "dinner";
}

function isMainMeal(meal: Meal): boolean {
  return meal.logged && meal.carbs >= 8;
}

function servingMacros(id: string): MacroEvent {
  const food = FOODS.find((item) => item.id === id);
  if (!food?.per100) throw new Error(`missing IFCT row ${id}`);
  const scale = food.grams / 100;
  return {
    min: 0,
    carbs: food.per100.carbs * scale,
    fiber: food.per100.fiber * scale,
    protein: food.per100.protein * scale,
    fat: food.per100.fat * scale,
    name: food.dish,
  };
}

function proteinSwap(meal: Meal): Meal {
  const add = sumMacros([
    { foodId: "toor", servings: 0.5 },
    { foodId: "paneer", servings: 0.5 },
  ]).macros;
  const targetCarbs = meal.carbs * 0.95;
  const carbCut = meal.carbs + add.carbs - targetCarbs;
  const frac = meal.carbs > 0 ? Math.min(0.85, Math.max(0, carbCut / meal.carbs)) : 0;
  return {
    ...meal,
    carbs: meal.carbs * (1 - frac) + add.carbs,
    fiber: meal.fiber * (1 - frac) + add.fiber,
    protein: meal.protein * (1 - frac) + add.protein,
    fat: meal.fat * (1 - frac) + add.fat,
    name: `${meal.name} · 5% of carb grams moved to dal and paneer`,
  };
}

function jowarSwap(meal: Meal): Meal {
  const jowar = servingMacros("jowar");
  const servings = jowar.carbs > 0 ? meal.carbs / jowar.carbs : 0;
  return {
    ...meal,
    carbs: meal.carbs,
    fiber: jowar.fiber * servings,
    protein: jowar.protein * servings,
    fat: jowar.fat * servings,
    name: "Jowar roti, same carbohydrate grams (IFCT A005)",
  };
}

function inWeek(min: number): boolean {
  return WEEK_DAYS.includes(Math.floor(min / 1440));
}

function applyPlan(
  meals: Meal[],
  walks: Walk[],
  id: PlanId,
  slot: MealSlot,
): { meals: MacroEvent[]; walks: WalkEvent[] } {
  const target = (meal: Meal) => inWeek(meal.min) && isMainMeal(meal) && slotOf(meal) === slot;
  const nextMeals: Meal[] = [];
  for (const meal of meals) {
    if (id === "fasting-day") {
      const day = Math.floor(meal.min / 1440);
      const skip = day === FASTING_PRESET_DAY && meal.logged && slotOf(meal) !== "dinner";
      if (!skip) nextMeals.push(meal);
      continue;
    }
    if (!target(meal)) {
      nextMeals.push(meal);
      continue;
    }
    if (id === "protein-swap") nextMeals.push(proteinSwap(meal));
    else if (id === "jowar-roti") nextMeals.push(jowarSwap(meal));
    else if (id === "earlier-meal")
      nextMeals.push({ ...meal, min: meal.min - 60, name: `${meal.name} · 60 min earlier` });
    else if (id === "split-meal") {
      const half = {
        carbs: meal.carbs / 2,
        fiber: meal.fiber / 2,
        protein: meal.protein / 2,
        fat: meal.fat / 2,
      };
      nextMeals.push({ ...meal, ...half, name: `${meal.name} · first half` });
      nextMeals.push({
        ...meal,
        ...half,
        id: `${meal.id}-b`,
        min: meal.min + 90,
        name: `${meal.name} · second half`,
      });
    } else nextMeals.push(meal);
  }
  const nextWalks: WalkEvent[] = walks.map((walk) => ({
    min: walk.min,
    durationMin: walk.durationMin,
  }));
  if (id === "walk-after-meal") {
    for (const meal of meals) {
      if (target(meal)) nextWalks.push({ min: meal.min + 20, durationMin: 15 });
    }
  }
  return {
    meals: nextMeals
      .filter((meal) => meal.logged !== false)
      .map((meal) => ({
        min: meal.min,
        carbs: meal.carbs,
        fiber: meal.fiber,
        protein: meal.protein,
        fat: meal.fat,
        name: meal.name,
      })),
    walks: nextWalks,
  };
}

function score(
  model: PatientModel,
  meals: MacroEvent[],
  walks: WalkEvent[],
): { tirPct: number; above180Min: number; below70Min: number; meanGlucose: number } {
  let n = 0;
  let inRange = 0;
  let above = 0;
  let below = 0;
  let sum = 0;
  for (const day of WEEK_DAYS) {
    for (let minute = 0; minute < 1440; minute += STEP_MIN) {
      const glucose = twinLevel(model, day * 1440 + minute, meals, walks);
      n += 1;
      sum += glucose;
      if (glucose >= 70 && glucose <= 180) inRange += 1;
      if (glucose > 180) above += 1;
      if (glucose < 70) below += 1;
    }
  }
  return {
    tirPct: n ? Math.round((inRange / n) * 1000) / 10 : 0,
    above180Min: above * STEP_MIN,
    below70Min: below * STEP_MIN,
    meanGlucose: n ? Math.round((sum / n) * 10) / 10 : 0,
  };
}

/** The slot whose meals keep the as-logged twin above 180 longest; ties fall to the highest post-meal peak. */
export function riskiestSlot(model: PatientModel): MealSlot {
  const meals = model.meals.filter((meal) => inWeek(meal.min));
  const logged = meals.filter((meal) => meal.logged);
  const walks = model.walks.filter((walk) => inWeek(walk.min));
  const stats: Record<MealSlot, { above: number; peakRise: number; n: number }> = {
    breakfast: { above: 0, peakRise: 0, n: 0 },
    lunch: { above: 0, peakRise: 0, n: 0 },
    dinner: { above: 0, peakRise: 0, n: 0 },
  };
  for (const meal of logged) {
    if (!isMainMeal(meal)) continue;
    const slot = slotOf(meal);
    const pre = twinLevel(model, meal.min, logged, walks);
    let peak = pre;
    for (let minute = STEP_MIN; minute <= AFTER_MEAL_MIN; minute += STEP_MIN) {
      const glucose = twinLevel(model, meal.min + minute, logged, walks);
      if (glucose > 180) stats[slot].above += STEP_MIN;
      peak = Math.max(peak, glucose);
    }
    stats[slot].peakRise += peak - pre;
    stats[slot].n += 1;
  }
  const order: MealSlot[] = ["dinner", "lunch", "breakfast"];
  return order.reduce((best, slot) => {
    const a = stats[slot];
    const b = stats[best];
    if (!a.n) return best;
    if (!b.n) return slot;
    if (a.above !== b.above) return a.above > b.above ? slot : best;
    return a.peakRise / a.n > b.peakRise / b.n ? slot : best;
  }, order[0]!);
}

function plansFor(slot: MealSlot): { id: PlanId; label: string; note: string }[] {
  const Slot = slot[0]!.toUpperCase() + slot.slice(1);
  return [
    {
      id: "as-logged",
      label: "As logged",
      note: "The meals and walks already on the stream. No medicine change.",
    },
    {
      id: "walk-after-meal",
      label: `Walk 15 min after ${slot}`,
      note: `A 15-minute walk starts 20 minutes after each logged ${slot}. No dosing.`,
    },
    {
      id: "protein-swap",
      label: `Dal and paneer for 5% of ${slot} carbs`,
      note: "Net carbohydrate grams fall by 5%. The twin has no separate protein effect. IFCT toor and paneer.",
    },
    {
      id: "earlier-meal",
      label: `${Slot} 60 min earlier`,
      note: "Same food, one hour earlier. No dosing.",
    },
    {
      id: "split-meal",
      label: `Split ${slot}`,
      note: `Half the ${slot} now, half 90 minutes later. No dosing.`,
    },
    {
      id: "jowar-roti",
      label: `Jowar roti at ${slot}, same carbs`,
      note: "Carbohydrate grams stay the same. Fiber follows IFCT jowar. Nature Medicine 2025 found no risk drop for this swap.",
    },
    {
      id: "fasting-day",
      label: "Fasting day once a week",
      note: "On one day of the week breakfast and lunch are skipped and dinner is eaten as usual. Review glucose-lowering medicines with the doctor first: fasting raises the risk of lows on some of them. No dosing.",
    },
  ];
}

/**
 * In the plan gain one point of time in range equals 14.4 minutes above 180,
 * and a minute under 70 counts as HYPO_WEIGHT minutes above 180, or
 * HYPO_WEIGHT_AT_RISK when the record lists a glucose-lowering drug or the
 * as-logged week already has lows. Lows are the more dangerous error; the
 * weights are a clinical modelling choice, not fitted.
 */
export const HYPO_WEIGHT = 3;
export const HYPO_WEIGHT_AT_RISK = 6;

export function rankPlans(model: PatientModel): PlanScore[] {
  const meals = model.meals.filter((meal) => inWeek(meal.min));
  const walks = model.walks.filter((walk) => inWeek(walk.min));
  const slot = riskiestSlot(model);
  const rows = plansFor(slot).map((plan) => {
    const edited = applyPlan(meals, walks, plan.id, slot);
    const scored = score(model, edited.meals, edited.walks);
    const why = buildWhy(model, plan.id, slot, scored);
    return { ...plan, ...scored, why: why.en, whyHi: why.hi };
  });
  const base = rows[0]!;
  const hypoWeight =
    model.patient.sulfonylureaFromDay != null || base.below70Min > 0 ? HYPO_WEIGHT_AT_RISK : HYPO_WEIGHT;
  const gain = (row: PlanScore) =>
    row.tirPct -
    base.tirPct -
    (row.above180Min - base.above180Min) / 14.4 -
    ((row.below70Min - base.below70Min) * hypoWeight) / 14.4 -
    (row.meanGlucose - base.meanGlucose) / 50;
  return [...rows].sort((a, b) => {
    if (a.id === "as-logged") return -1;
    if (b.id === "as-logged") return 1;
    return gain(b) - gain(a);
  });
}

const GROUP_HI: Record<Group, string> = { t2d: "टाइप 2", prediabetes: "प्रीडायबिटीज़", healthy: "सामान्य" };
const GROUP_EN: Record<Group, string> = { t2d: "Type 2", prediabetes: "prediabetes", healthy: "healthy" };

/**
 * One sentence, in English and Hindi, on what in this patient's fitted twin
 * moved the plan: the medication term, the cluster, or a knob compared with
 * its group mean (POP). Empty when nothing patient-specific applies; the
 * plan's `note` carries the general description.
 */
function buildWhy(
  model: PatientModel,
  id: PlanId,
  slot: MealSlot,
  scored: { tirPct: number; above180Min: number; below70Min: number; meanGlucose: number },
): { en: string; hi: string } {
  const knobs = model.params.knobs;
  const group = model.patient.group;
  const prior = POP[group];
  const onDrug = model.patient.sulfonylureaFromDay != null;
  const hi = slotHi(slot);
  const ratio = (personal: number, mean: number): number => (mean > 0 ? personal / mean : 1);
  const carbRatio = ratio(knobs.carbSensitivity, prior.carbSensitivity);
  const dawnRatio = ratio(knobs.dawnAmp, prior.dawnAmp);
  const activityRatio = ratio(knobs.activityEffect, prior.activityEffect);
  const pctAbove = (value: number) => Math.round((value - 1) * 100);
  if (id === "fasting-day" && onDrug) {
    return {
      en: "A glucose-lowering drug on the medication list could push a fasting-day low under 70. Review the medicines with the prescriber first.",
      hi: "दवा सूची में शुगर कम करने वाली दवा है, इसलिए उपवास के दिन शुगर 70 से नीचे जा सकती है। पहले डॉक्टर से दवाओं की समीक्षा कराएँ।",
    };
  }
  if (id === "fasting-day" && scored.below70Min > 0) {
    return {
      en: `${scored.below70Min} min under 70 in the simulated week, so a fasting day is unsafe here.`,
      hi: `सिम्युलेटेड हफ़्ते में ${scored.below70Min} मिनट शुगर 70 से नीचे रही, इसलिए यहाँ उपवास का दिन सुरक्षित नहीं है।`,
    };
  }
  if (id === "walk-after-meal" && activityRatio > 1.15) {
    return {
      en: `This patient's walk lowers glucose by ${knobs.activityEffect.toFixed(1)} mg/dL per 30 minutes, ${pctAbove(activityRatio)}% above the ${GROUP_EN[group]} group average, so a walk after ${slot} is a reliable way to raise time in range.`,
      hi: `इस मरीज़ में 30 मिनट की सैर से शुगर ${knobs.activityEffect.toFixed(1)} mg/dL घटती है, जो ${GROUP_HI[group]} समूह के औसत से ${pctAbove(activityRatio)}% अधिक है, इसलिए ${hi.oblique} के बाद सैर टाइम इन रेंज बढ़ाने का भरोसेमंद तरीका है।`,
    };
  }
  if (id === "walk-after-meal") {
    return {
      en: `A walk raises this patient's sensitivity for the next 12–30 hours, which lowers the rise after ${slot}.`,
      hi: `सैर के बाद अगले 12–30 घंटे तक इस मरीज़ की संवेदनशीलता बढ़ी रहती है, जिससे ${hi.oblique} के बाद शुगर कम बढ़ती है।`,
    };
  }
  if (id === "protein-swap" && carbRatio > 1.15) {
    return {
      en: `This patient's carb sensitivity is ${carbRatio.toFixed(2)}× the ${GROUP_EN[group]} group average (${knobs.carbSensitivity.toFixed(1)} vs ${prior.carbSensitivity.toFixed(1)}), so a 5% carb cut at ${slot} with dal and paneer moves this twin more than an average one.`,
      hi: `इस मरीज़ की कार्बोहाइड्रेट संवेदनशीलता ${GROUP_HI[group]} समूह के औसत की ${carbRatio.toFixed(2)} गुना है (${knobs.carbSensitivity.toFixed(1)} बनाम ${prior.carbSensitivity.toFixed(1)}), इसलिए ${hi.oblique} में दाल-पनीर से 5% कार्ब कम करने का असर औसत मरीज़ से ज़्यादा होता है।`,
    };
  }
  if (id === "protein-swap") {
    return {
      en: `A 5% carb cut at ${slot} changes this twin only a little: a low-risk default, rarely the top plan.`,
      hi: `${hi.oblique} में 5% कार्ब कम करने से इस ट्विन पर असर कम है: सुरक्षित विकल्प, पर शायद ही सबसे ऊपर।`,
    };
  }
  if (id === "earlier-meal" && slot === "breakfast" && dawnRatio > 1.4) {
    return {
      en: `This patient's dawn rise is ${knobs.dawnAmp.toFixed(1)} mg/dL, ${pctAbove(dawnRatio)}% above the ${GROUP_EN[group]} group average, and an earlier breakfast keeps the meal rise from stacking on the high early-morning level.`,
      hi: `इस मरीज़ में सुबह की शुगर ${knobs.dawnAmp.toFixed(1)} mg/dL बढ़ती है, जो ${GROUP_HI[group]} समूह के औसत से ${pctAbove(dawnRatio)}% अधिक है; नाश्ता पहले करने से खाने की बढ़त सुबह की ऊँची शुगर पर नहीं चढ़ती।`,
    };
  }
  if (id === "earlier-meal") {
    return {
      en: `Eating ${slot} 60 minutes earlier moves its rise to a time of day when this twin's meal response is smaller.`,
      hi: `${hi.direct} 60 मिनट पहले करने से बढ़त दिन के उस समय पर आती है जब इस ट्विन में खाने का असर कम होता है।`,
    };
  }
  if (id === "split-meal" && onDrug) {
    return {
      en: `A glucose-lowering drug on the record adds a fall that starts about 3 hours after a meal. Splitting ${slot} halves the load at any one time, the closest the twin can come to softening that fall without a medicine change.`,
      hi: `रिकॉर्ड में शुगर कम करने वाली दवा है, जिससे खाने के लगभग 3 घंटे बाद गिरावट शुरू होती है। ${hi.direct} दो हिस्सों में खाने से एक बार का भार आधा होता है; दवा बदले बिना ट्विन में यही सबसे क़रीबी उपाय है।`,
    };
  }
  if (id === "split-meal" && model.patient.cluster === "SIDD") {
    return {
      en: `The approximate SIDD cluster points to limited secretion, so splitting ${slot} gives the remaining secretion a smaller load each time.`,
      hi: `अनुमानित SIDD समूह में शरीर कम इंसुलिन बनाता है, इसलिए ${hi.direct} बाँटकर खाने से हर बार कम भार पड़ता है।`,
    };
  }
  if (id === "split-meal") {
    return {
      en: `Spreading the same ${slot} carbs 90 minutes apart lowers this twin's peak.`,
      hi: `${hi.oblique} के उतने ही कार्ब 90 मिनट के अंतर पर बाँटने से इस ट्विन का पीक कम होता है।`,
    };
  }
  if (id === "jowar-roti") {
    return {
      en: "Carbohydrate grams stay the same and fibre follows IFCT jowar. Nature Medicine 2025 found no risk drop for this swap, so it is listed as a preference option.",
      hi: "कार्बोहाइड्रेट उतने ही रहते हैं और फ़ाइबर IFCT ज्वार के अनुसार। Nature Medicine 2025 में इस बदलाव से जोखिम नहीं घटा, इसलिए यह केवल पसंद के विकल्प के रूप में है।",
    };
  }
  if (id === "as-logged") {
    return {
      en: "Baseline reference (shown at the top of the table for comparison; candidate plans are ranked below it by net glycemic gain).",
      hi: "आधार रेखा (तुलना के लिए तालिका में सबसे ऊपर; बाकी योजनाएँ इसके नीचे शुद्ध ग्लाइसेमिक लाभ के क्रम में हैं)।",
    };
  }
  return { en: "", hi: "" };
}

export function planDeltas(
  rows: PlanScore[],
): { id: PlanId; tir: number; above: number; below: number; mean: number }[] {
  const base = rows.find((row) => row.id === "as-logged") ?? rows[0]!;
  return rows.map((row) => ({
    id: row.id,
    tir: Math.round((row.tirPct - base.tirPct) * 10) / 10,
    above: row.above180Min - base.above180Min,
    below: row.below70Min - base.below70Min,
    mean: Math.round((row.meanGlucose - base.meanGlucose) * 10) / 10,
  }));
}
