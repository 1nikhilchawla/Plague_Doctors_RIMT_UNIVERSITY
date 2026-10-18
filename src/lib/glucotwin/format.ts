import { mgdlToMmol } from "./physics.ts";

export type GlucoseUnit = "mgdl" | "mmol";

const CLOCK = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const WHEN = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const DAY = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "numeric",
  month: "short",
});

export function formatClock(ms: number): string {
  return CLOCK.format(ms);
}

export function formatClockIn(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);
}

export function formatWhen(ms: number): string {
  return WHEN.format(ms);
}

export function formatWhenIn(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(ms);
}

export function formatDay(ms: number): string {
  return DAY.format(ms);
}

export function formatDayIn(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone,
    day: "numeric",
    month: "short",
  }).format(ms);
}

export function formatGlucose(mgdl: number, unit: GlucoseUnit): string {
  if (unit === "mmol") return mgdlToMmol(mgdl).toFixed(1);
  return Math.round(mgdl).toString();
}

export function glucoseUnitLabel(unit: GlucoseUnit): string {
  return unit === "mmol" ? "mmol/L" : "mg/dL";
}

/** One decimal, half away from zero the way `Number#toFixed` does. */
export function formatHours(hours: number): string {
  return hours.toFixed(1);
}

export function displayThreshold(mgdl: number, unit: GlucoseUnit): number {
  return unit === "mmol" ? mgdlToMmol(mgdl) : mgdl;
}
