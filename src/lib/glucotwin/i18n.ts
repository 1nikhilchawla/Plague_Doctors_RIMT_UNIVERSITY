/**
 * English / हिन्दी text for the patient-facing parts: the What-if plan table and
 * the printable pre-visit summary. Built in, so the sheet prints without a
 * network. A key missing from Hindi falls back to English.
 */
import type { MealSlot, PlanId } from "./protocol.ts";

export type Locale = "en" | "hi";
export const LOCALES: { id: Locale; label: string }[] = [
  { id: "en", label: "EN" },
  { id: "hi", label: "हिन्दी" },
];

const EN = {
  "summary.kicker": "GlucoTwin · pre-visit clinical summary",
  "summary.years": "y",
  "summary.female": "Female",
  "summary.male": "Male",
  "summary.recordWithdrawn": "Health record withdrawn",
  "summary.dataTo": "Data to {when}",
  "summary.simWard": "Simulated ward, seed 42",
  "summary.realWard": "CGMacros (real, de-identified)",
  "summary.consentRecord": "Consent: record",
  "summary.consentWearables": "wearables",
  "summary.shared": "shared",
  "summary.withdrawn": "withdrawn",
  "summary.last7": "Last 7 days",
  "summary.twin": "Twin parameters",
  "summary.planSelected": "Lifestyle plan selected by the doctor",
  "summary.planTop": "Top-ranked lifestyle plan",
  "summary.whyForPatient": "Why this plan for this patient: ",
  "summary.simulated": "Simulated on this person's fitted twin over one week, out of seven plans.",
  "summary.advice": "Simulation, not advice.",
  "summary.noPlan": "No plan comparison is available for this record.",
  "summary.urgentHeader": "Urgent alerts, last 7 days",
  "summary.noUrgent": "No urgent alerts in the last 7 days.",
  "summary.foot":
    "Research prototype — not a medical device, not medical advice. No dosing and no diagnosis. Review with the treating doctor.",
  "whatif.header": "Plans for this person",
  "whatif.note":
    "Ranked on days 10–16 with the fitted twin. Plans change this person's highest-risk meal. Gain treats one point of time in range as 14.4 minutes above 180, and a minute under 70 as 3 minutes above 180 (6 with a glucose-lowering drug or existing lows). No medicine dosing. Simulation, not advice.",
  "whatif.selectedPrefix": "Selected:",
  "whatif.colPlan": "Plan",
  "whatif.colTir": "Time in range",
  "whatif.colAbove": "Min above 180",
  "whatif.colBelow": "Min under 70",
  "whatif.colMean": "Mean mg/dL",
  "whatif.select": "Select",
  "whatif.selected": "Selected",
  "whatif.why": "Why: ",
  "language.label": "Language for the plan table and the printed summary",
} as const;

export type TextKey = keyof typeof EN;

const HI: Partial<Record<TextKey, string>> = {
  "summary.kicker": "GlucoTwin · डॉक्टर से मिलने से पहले का सारांश",
  "summary.years": "वर्ष",
  "summary.female": "महिला",
  "summary.male": "पुरुष",
  "summary.recordWithdrawn": "स्वास्थ्य रिकॉर्ड की सहमति वापस ली गई",
  "summary.dataTo": "{when} तक का डेटा",
  "summary.simWard": "सिम्युलेटेड वार्ड, seed 42",
  "summary.realWard": "CGMacros (वास्तविक, पहचान हटाई गई)",
  "summary.consentRecord": "सहमति: रिकॉर्ड",
  "summary.consentWearables": "वियरेबल",
  "summary.shared": "साझा",
  "summary.withdrawn": "वापस ली गई",
  "summary.last7": "पिछले 7 दिन",
  "summary.twin": "ट्विन के पैरामीटर",
  "summary.planSelected": "डॉक्टर द्वारा चुनी गई जीवनशैली योजना",
  "summary.planTop": "सबसे ऊपर रैंक की गई जीवनशैली योजना",
  "summary.whyForPatient": "इस मरीज़ के लिए यह योजना क्यों: ",
  "summary.simulated": "इस मरीज़ के फ़िट किए गए ट्विन पर एक हफ़्ते का सिम्युलेशन, सात योजनाओं में से।",
  "summary.advice": "यह सिम्युलेशन है, सलाह नहीं।",
  "summary.noPlan": "इस रिकॉर्ड के लिए योजनाओं की तुलना उपलब्ध नहीं है।",
  "summary.urgentHeader": "अर्जेंट अलर्ट, पिछले 7 दिन",
  "summary.noUrgent": "पिछले 7 दिनों में कोई अर्जेंट अलर्ट नहीं।",
  "summary.foot":
    "शोध प्रोटोटाइप — यह चिकित्सा उपकरण या चिकित्सा सलाह नहीं है। इसमें न दवा की खुराक है, न निदान। अपने इलाज करने वाले डॉक्टर के साथ ही इसे देखें।",
  "whatif.header": "इस मरीज़ के लिए योजनाएँ",
  "whatif.note":
    "फ़िट किए गए ट्विन पर दिन 10–16 के आधार पर क्रम। योजनाएँ इस मरीज़ के सबसे जोखिम वाले भोजन को बदलती हैं। टाइम इन रेंज का एक अंक 180 से ऊपर के 14.4 मिनट के बराबर है, और 70 से नीचे का एक मिनट 180 से ऊपर के 3 मिनट के बराबर (शुगर कम करने वाली दवा या पहले से लो शुगर होने पर 6)। दवा की कोई खुराक नहीं। यह सिम्युलेशन है, सलाह नहीं।",
  "whatif.selectedPrefix": "चुनी गई:",
  "whatif.colPlan": "योजना",
  "whatif.colTir": "टाइम इन रेंज",
  "whatif.colAbove": "180 से ऊपर (मिनट)",
  "whatif.colBelow": "70 से नीचे (मिनट)",
  "whatif.colMean": "औसत mg/dL",
  "whatif.select": "चुनें",
  "whatif.selected": "चुनी गई",
  "whatif.why": "क्यों: ",
  "language.label": "योजना तालिका और प्रिंट सारांश की भाषा",
};

/** Text for `key` in `locale`; Hindi falls back to English when a key is missing. */
export function t(key: TextKey, locale: Locale): string {
  return (locale === "hi" ? HI[key] : undefined) ?? EN[key];
}

/** Hindi meal names: oblique ("नाश्ते के बाद") and direct ("नाश्ता 60 मिनट पहले"). */
export function slotHi(slot: MealSlot): { oblique: string; direct: string } {
  return SLOT_HI[slot];
}

const SLOT_HI: Record<MealSlot, { oblique: string; direct: string }> = {
  breakfast: { oblique: "नाश्ते", direct: "नाश्ता" },
  lunch: { oblique: "दोपहर के खाने", direct: "दोपहर का खाना" },
  dinner: { oblique: "रात के खाने", direct: "रात का खाना" },
};

const PLAN_HI: Record<PlanId, (slot: { oblique: string; direct: string }) => { label: string; note: string }> = {
  "as-logged": () => ({
    label: "जैसा दर्ज है",
    note: "स्ट्रीम पर पहले से दर्ज भोजन और सैर। दवा में कोई बदलाव नहीं।",
  }),
  "walk-after-meal": (slot) => ({
    label: `${slot.oblique} के बाद 15 मिनट टहलें`,
    note: `हर दर्ज ${slot.oblique} के 20 मिनट बाद 15 मिनट की सैर। कोई खुराक नहीं।`,
  }),
  "protein-swap": (slot) => ({
    label: `${slot.oblique} के 5% कार्बोहाइड्रेट की जगह दाल और पनीर`,
    note: "कुल कार्बोहाइड्रेट ग्राम 5% कम होते हैं। ट्विन में प्रोटीन का अलग असर नहीं है। IFCT तूर दाल और पनीर।",
  }),
  "earlier-meal": (slot) => ({
    label: `${slot.direct} 60 मिनट पहले`,
    note: "वही खाना, एक घंटा पहले। कोई खुराक नहीं।",
  }),
  "split-meal": (slot) => ({
    label: `${slot.direct} दो हिस्सों में`,
    note: `आधा ${slot.direct} अभी, आधा 90 मिनट बाद। कोई खुराक नहीं।`,
  }),
  "jowar-roti": (slot) => ({
    label: `${slot.oblique} में ज्वार की रोटी, कार्बोहाइड्रेट उतने ही`,
    note: "कार्बोहाइड्रेट ग्राम उतने ही रहते हैं। फ़ाइबर IFCT ज्वार के अनुसार। Nature Medicine 2025 में इस बदलाव से जोखिम में कमी नहीं मिली।",
  }),
  "fasting-day": () => ({
    label: "हफ़्ते में एक दिन उपवास",
    note: "हफ़्ते के एक दिन नाश्ता और दोपहर का खाना छोड़ा जाता है और रात का खाना सामान्य रहता है। पहले डॉक्टर से शुगर कम करने वाली दवाओं की समीक्षा करें: कुछ दवाओं के साथ उपवास से लो शुगर का जोखिम बढ़ता है। कोई खुराक नहीं।",
  }),
};

/** A plan's label and note in `locale`. English keeps the scorer's own text. */
export function planText(
  plan: { id: PlanId; label: string; note: string },
  slot: MealSlot,
  locale: Locale,
): { label: string; note: string } {
  if (locale === "en") return { label: plan.label, note: plan.note };
  return PLAN_HI[plan.id](SLOT_HI[slot]);
}
