/**
 * Indian foods for the what-if builder.
 * Macros are IFCT 2017 per 100 g edible portion (Longvah et al., NIN/ICMR),
 * scaled to the stated serving. GI is not in IFCT — left blank.
 * Dishes without a verified row stay null and cannot drive a forecast.
 */

export type Macro = {
  carbs: number;
  fiber: number;
  protein: number;
  fat: number;
};

export type Food = {
  id: string;
  dish: string;
  serving: string;
  grams: number;
  code: string;
  per100: Macro | null;
  source: string;
};

const IFCT = "IFCT 2017, Longvah et al., NIN–ICMR";

function food(
  id: string,
  dish: string,
  serving: string,
  grams: number,
  code: string,
  per100: Macro | null,
): Food {
  return {
    id,
    dish,
    serving,
    grams,
    code,
    per100,
    source: per100 ? `${IFCT}, code ${code}, per 100 g, scaled to this serving` : "needs_source",
  };
}

export const FOODS: Food[] = [
  food("atta", "Chapati (whole-wheat atta)", "1 chapati, 30 g atta", 30, "A019", {
    carbs: 64.17,
    fiber: 11.36,
    protein: 10.57,
    fat: 1.53,
  }),
  food("rice", "Rice, raw, milled", "1 small bowl, 40 g raw", 40, "A015", {
    carbs: 78.24,
    fiber: 2.81,
    protein: 7.94,
    fat: 0.52,
  }),
  food("rice-par", "Rice, parboiled, milled", "1 small bowl, 40 g raw", 40, "A014", {
    carbs: 77.16,
    fiber: 3.74,
    protein: 7.81,
    fat: 0.55,
  }),
  food("poha", "Rice flakes (poha), dry", "40 g dry", 40, "A011", {
    carbs: 76.75,
    fiber: 3.46,
    protein: 7.44,
    fat: 1.14,
  }),
  food("murmura", "Rice, puffed", "20 g", 20, "A012", {
    carbs: 77.68,
    fiber: 2.56,
    protein: 7.47,
    fat: 1.62,
  }),
  food("rava", "Wheat semolina (rava)", "40 g dry", 40, "A022", {
    carbs: 68.43,
    fiber: 9.72,
    protein: 11.38,
    fat: 0.74,
  }),
  food("sevai", "Wheat vermicelli", "40 g dry", 40, "A023", {
    carbs: 70.39,
    fiber: 9.28,
    protein: 9.7,
    fat: 0.45,
  }),
  food("ragi", "Ragi", "30 g", 30, "A010", {
    carbs: 66.82,
    fiber: 11.18,
    protein: 7.16,
    fat: 1.92,
  }),
  food("jowar", "Jowar", "40 g", 40, "A005", {
    carbs: 67.68,
    fiber: 10.22,
    protein: 9.97,
    fat: 1.73,
  }),
  food("bajra", "Bajra", "40 g", 40, "A003", {
    carbs: 61.78,
    fiber: 11.49,
    protein: 10.96,
    fat: 5.43,
  }),
  food("barley", "Barley", "40 g", 40, "A004", {
    carbs: 61.29,
    fiber: 15.64,
    protein: 10.94,
    fat: 1.3,
  }),
  food("toor", "Red gram dal (toor)", "1 katori, 25 g dry", 25, "B021", {
    carbs: 55.23,
    fiber: 9.06,
    protein: 21.7,
    fat: 1.56,
  }),
  food("moong", "Green gram dal (moong)", "25 g dry", 25, "B010", {
    carbs: 52.59,
    fiber: 9.37,
    protein: 23.88,
    fat: 1.35,
  }),
  food("chana-dal", "Bengal gram dal (chana)", "25 g dry", 25, "B001", {
    carbs: 46.72,
    fiber: 15.15,
    protein: 21.55,
    fat: 5.31,
  }),
  food("masoor", "Lentil dal (masoor)", "25 g dry", 25, "B013", {
    carbs: 52.53,
    fiber: 10.43,
    protein: 24.35,
    fat: 0.75,
  }),
  food("urad", "Black gram dal (urad)", "25 g dry", 25, "B003", {
    carbs: 51,
    fiber: 11.93,
    protein: 23.06,
    fat: 1.69,
  }),
  food("rajma", "Rajmah, red", "30 g dry", 30, "B020", {
    carbs: 48.61,
    fiber: 16.57,
    protein: 19.91,
    fat: 1.77,
  }),
  food("chole", "Bengal gram, whole (chole)", "30 g dry", 30, "B002", {
    carbs: 39.56,
    fiber: 25.22,
    protein: 18.77,
    fat: 5.11,
  }),
  food("potato", "Potato, brown skin", "100 g", 100, "F006", {
    carbs: 14.89,
    fiber: 1.71,
    protein: 1.54,
    fat: 0.23,
  }),
  food("banana", "Banana, ripe, robusta", "100 g", 100, "E012", {
    carbs: 23.63,
    fiber: 1.94,
    protein: 1.23,
    fat: 0.33,
  }),
  food("mango", "Mango, ripe, Banganapalli", "100 g", 100, "E036", {
    carbs: 8.18,
    fiber: 1.88,
    protein: 0.54,
    fat: 0.55,
  }),
  food("apple", "Apple", "100 g", 100, "E001", {
    carbs: 13.11,
    fiber: 2.59,
    protein: 0.29,
    fat: 0.64,
  }),
  food("guava", "Guava, white flesh", "100 g", 100, "E028", {
    carbs: 5.13,
    fiber: 8.59,
    protein: 1.44,
    fat: 0.32,
  }),
  food("papaya", "Papaya, ripe", "150 g", 150, "E049", {
    carbs: 4.61,
    fiber: 2.83,
    protein: 0.42,
    fat: 0.16,
  }),
  food("orange", "Orange, pulp", "150 g", 150, "E047", {
    carbs: 7.92,
    fiber: 1.29,
    protein: 0.7,
    fat: 0.13,
  }),
  food("dates", "Dates, dry, pale brown", "20 g", 20, "E017", {
    carbs: 74.91,
    fiber: 8.95,
    protein: 2.45,
    fat: 0.35,
  }),
  food("jaggery", "Jaggery, cane", "10 g", 10, "I001", {
    carbs: 84.87,
    fiber: 0,
    protein: 1.85,
    fat: 0.16,
  }),
  food("milk-cow", "Milk, whole, cow", "200 g", 200, "L002", {
    carbs: 4.94,
    fiber: 0,
    protein: 3.26,
    fat: 4.48,
  }),
  food("milk-buf", "Milk, whole, buffalo", "150 g", 150, "L001", {
    carbs: 8.39,
    fiber: 0,
    protein: 3.68,
    fat: 6.58,
  }),
  food("paneer", "Paneer", "50 g", 50, "L003", {
    carbs: 12.41,
    fiber: 0,
    protein: 18.86,
    fat: 14.78,
  }),
  food("khoa", "Khoa", "20 g", 20, "L004", {
    carbs: 16.53,
    fiber: 0,
    protein: 16.34,
    fat: 20.62,
  }),
  food("egg", "Egg, poultry, boiled", "1 egg, 50 g", 50, "M004", {
    carbs: 0,
    fiber: 0,
    protein: 13.43,
    fat: 10.54,
  }),
  food("chicken", "Chicken breast, skinless", "80 g", 80, "N003", {
    carbs: 0,
    fiber: 0,
    protein: 21.81,
    fat: 9,
  }),
  food("spinach", "Spinach", "100 g", 100, "C033", {
    carbs: 2.05,
    fiber: 2.38,
    protein: 2.14,
    fat: 0.64,
  }),
  food("tomato", "Tomato, ripe, local", "100 g", 100, "D076", {
    carbs: 2.71,
    fiber: 1.77,
    protein: 0.9,
    fat: 0.47,
  }),
  food("onion", "Onion", "40 g", 40, "G017", {
    carbs: 9.56,
    fiber: 2.45,
    protein: 1.5,
    fat: 0.24,
  }),
  food("carrot", "Carrot, orange", "80 g", 80, "F002", {
    carbs: 5.55,
    fiber: 4.18,
    protein: 0.95,
    fat: 0.47,
  }),
  food("peas", "Peas, fresh", "80 g", 80, "D061", {
    carbs: 11.88,
    fiber: 6.32,
    protein: 7.25,
    fat: 0.13,
  }),
  food("cauli", "Cauliflower", "80 g", 80, "D036", {
    carbs: 2.03,
    fiber: 3.71,
    protein: 2.15,
    fat: 0.44,
  }),
  food("cabbage", "Cabbage, green", "80 g", 80, "C015", {
    carbs: 3.25,
    fiber: 2.76,
    protein: 1.36,
    fat: 0.12,
  }),
  food("brinjal", "Brinjal", "80 g", 80, "D031", {
    carbs: 3.52,
    fiber: 3.98,
    protein: 1.48,
    fat: 0.32,
  }),
  food("groundnut", "Groundnut", "20 g", 20, "H012", {
    carbs: 17.27,
    fiber: 10.38,
    protein: 23.65,
    fat: 39.63,
  }),
  food("coconut", "Coconut, kernel, fresh", "20 g", 20, "H007", {
    carbs: 6.3,
    fiber: 10.42,
    protein: 3.84,
    fat: 41.38,
  }),
  food("almond", "Almond", "10 g", 10, "H001", {
    carbs: 3.04,
    fiber: 13.06,
    protein: 18.41,
    fat: 58.49,
  }),
  food("oil-gn", "Groundnut oil", "1 tsp, 5 g", 5, "T005", {
    carbs: 0,
    fiber: 0,
    protein: 0,
    fat: 100,
  }),
  food("oil-must", "Mustard oil", "1 tsp, 5 g", 5, "T006", {
    carbs: 0,
    fiber: 0,
    protein: 0,
    fat: 100,
  }),
  food("ghee", "Ghee", "1 tsp, 5 g", 5, "T013", {
    carbs: 0,
    fiber: 0,
    protein: 0,
    fat: 100,
  }),
  food("oil-sun", "Sunflower oil", "1 tsp, 5 g", 5, "T012", {
    carbs: 0,
    fiber: 0,
    protein: 0,
    fat: 100,
  }),
  food("idli", "Idli", "2 pieces", 80, "", null),
  food("dosa", "Masala dosa", "1 dosa", 150, "", null),
  food("khichdi", "Khichdi", "1 bowl", 250, "", null),
];

export const FOOD_BY_ID: Record<string, Food> = Object.fromEntries(FOODS.map((f) => [f.id, f]));

export type PlateItem = { foodId: string; servings: number };

export type Plate = { id: string; name: string; items: PlateItem[] };

export const PLATES: Plate[] = [
  {
    id: "roti-dal",
    name: "Two chapatis and toor dal",
    items: [
      { foodId: "atta", servings: 2 },
      { foodId: "toor", servings: 1 },
      { foodId: "ghee", servings: 1 },
    ],
  },
  {
    id: "rice-dal",
    name: "Rice and toor dal",
    items: [
      { foodId: "rice", servings: 2 },
      { foodId: "toor", servings: 1 },
      { foodId: "ghee", servings: 1 },
    ],
  },
  {
    id: "rice-rajma",
    name: "Rice and rajma",
    items: [
      { foodId: "rice", servings: 1.5 },
      { foodId: "rajma", servings: 2 },
      { foodId: "onion", servings: 1 },
      { foodId: "oil-gn", servings: 1 },
    ],
  },
  {
    id: "poha-plate",
    name: "Poha with groundnut",
    items: [
      { foodId: "poha", servings: 1.5 },
      { foodId: "groundnut", servings: 1 },
      { foodId: "onion", servings: 1 },
      { foodId: "oil-must", servings: 1 },
    ],
  },
  {
    id: "upma",
    name: "Rava upma",
    items: [
      { foodId: "rava", servings: 1.5 },
      { foodId: "onion", servings: 1 },
      { foodId: "oil-sun", servings: 1 },
    ],
  },
  {
    id: "chole-roti",
    name: "Chole and two chapatis",
    items: [
      { foodId: "chole", servings: 2 },
      { foodId: "atta", servings: 2 },
      { foodId: "onion", servings: 1 },
    ],
  },
  {
    id: "chicken-roti",
    name: "Chicken and two chapatis",
    items: [
      { foodId: "chicken", servings: 1 },
      { foodId: "atta", servings: 2 },
    ],
  },
  {
    id: "fruit",
    name: "Fruit plate",
    items: [
      { foodId: "banana", servings: 1 },
      { foodId: "guava", servings: 1 },
    ],
  },
  {
    id: "milk-jaggery",
    name: "Milk with jaggery",
    items: [
      { foodId: "milk-cow", servings: 1 },
      { foodId: "jaggery", servings: 1 },
    ],
  },
  {
    id: "light-veg",
    name: "Light vegetables",
    items: [
      { foodId: "spinach", servings: 1 },
      { foodId: "tomato", servings: 1 },
      { foodId: "atta", servings: 1 },
    ],
  },
];

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function foodMacros(foodId: string, servings: number): Macro | null {
  const food = FOOD_BY_ID[foodId];
  if (!food?.per100) return null;
  const factor = (food.grams * servings) / 100;
  return {
    carbs: round2(food.per100.carbs * factor),
    fiber: round2(food.per100.fiber * factor),
    protein: round2(food.per100.protein * factor),
    fat: round2(food.per100.fat * factor),
  };
}

export function sumMacros(items: PlateItem[]): { macros: Macro; unresolved: string[] } {
  const macros: Macro = { carbs: 0, fiber: 0, protein: 0, fat: 0 };
  const unresolved: string[] = [];
  for (const item of items) {
    const part = foodMacros(item.foodId, item.servings);
    const food = FOOD_BY_ID[item.foodId];
    if (!part || !food) {
      unresolved.push(food?.dish ?? item.foodId);
      continue;
    }
    macros.carbs = round2(macros.carbs + part.carbs);
    macros.fiber = round2(macros.fiber + part.fiber);
    macros.protein = round2(macros.protein + part.protein);
    macros.fat = round2(macros.fat + part.fat);
  }
  return { macros, unresolved };
}

export function plateMacros(plate: Plate): { macros: Macro; unresolved: string[] } {
  return sumMacros(plate.items);
}

export function describeItems(items: PlateItem[]): string {
  return items
    .map((item) => {
      const food = FOOD_BY_ID[item.foodId];
      const name = food?.dish ?? item.foodId;
      const qty = item.servings === 1 ? "" : ` × ${item.servings}`;
      return `${name}${qty}`;
    })
    .join(", ");
}
