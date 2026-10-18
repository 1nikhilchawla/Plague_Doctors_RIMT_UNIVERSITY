import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  availableIndex,
  clockMs,
  forecastAt,
  isStreamStale,
  type PatientModel,
} from "@/lib/glucotwin/cohort";
import {
  displayThreshold,
  formatClockIn,
  glucoseUnitLabel,
  type GlucoseUnit,
} from "@/lib/glucotwin/format";
import { STEP_MIN, type CurvePoint } from "@/lib/glucotwin/physics";

type Row = {
  label: string;
  glucose: number | null;
  forecast: number | null;
  bandBase: number | null;
  band: number | null;
  alt: number | null;
  meal: number | null;
  walk: number | null;
};

function toUnit(mgdl: number, unit: GlucoseUnit): number {
  return unit === "mmol" ? Math.round((mgdl / 18) * 10) / 10 : Math.round(mgdl);
}

function place(rows: Row[], index: number, start: number, key: "meal" | "walk", y: number) {
  const slot = index - start;
  if (slot >= 0 && slot < rows.length) rows[slot]![key] = y;
}

/** Clinical ticks only. The axis never starts at 0. */
function clinicalScale(
  unit: GlucoseUnit,
  values: number[],
): { lo: number; hi: number; ticks: number[] } {
  const low = displayThreshold(70, unit);
  const high = displayThreshold(180, unit);
  const floor = unit === "mmol" ? 2 : 40;
  const cap = unit === "mmol" ? 22 : 400;
  const pad = unit === "mmol" ? 0.6 : 12;
  const present = values.length ? values : [low, high];
  const yMin = Math.max(floor, Math.min(low, ...present) - pad);
  const yMax = Math.min(cap, Math.max(high, ...present) + pad);
  const lo = Math.floor(yMin);
  const hi = Math.ceil(yMax);
  const marks = [70, 180, 250, 300].map((mgdl) => displayThreshold(mgdl, unit));
  const ticks = marks.filter((tick) => tick >= lo && tick <= hi);
  return { lo, hi, ticks: ticks.length ? ticks : [low, high] };
}

function GlucoseAxis({
  unit,
  lo,
  hi,
  ticks,
}: {
  unit: GlucoseUnit;
  lo: number;
  hi: number;
  ticks: number[];
}) {
  return (
    <YAxis
      domain={[lo, hi]}
      ticks={ticks}
      tick={{ fill: "var(--color-muted)", fontSize: 11 }}
      width={52}
      axisLine={false}
      tickLine={false}
      label={{
        value: glucoseUnitLabel(unit),
        angle: -90,
        position: "insideLeft",
        style: { fill: "var(--color-muted)", fontSize: 11 },
      }}
    />
  );
}

export function GlucoseChart({
  model,
  wardIndex,
  unit,
  comparison,
  comparisonName = "What-if",
  horizonMin = 120,
}: {
  model: PatientModel;
  wardIndex: number;
  unit: GlucoseUnit;
  comparison?: CurvePoint[] | null;
  comparisonName?: string;
  horizonMin?: number;
}) {
  const dataEnd = availableIndex(model, wardIndex);
  const stale = isStreamStale(model, wardIndex);
  const start = Math.max(0, dataEnd - 72);
  // `model` is already the consented twin (routes/index.tsx), so forecastAt applies its consent.
  const curve = stale ? null : forecastAt(model, dataEnd, { horizonMin });
  const end = curve
    ? dataEnd + (curve.length - 1)
    : Math.max(dataEnd, Math.min(wardIndex, model.readings.length - 1));
  const rows: Row[] = [];
  for (let index = start; index <= end; index += 1) {
    const reading = model.readings[index];
    const glucose =
      index <= dataEnd && reading?.glucose != null ? toUnit(reading.glucose, unit) : null;
    rows.push({
      label: formatClockIn(clockMs(model, index), model.patient.simulated ? "Asia/Kolkata" : "UTC"),
      glucose,
      forecast: null,
      bandBase: null,
      band: null,
      alt: null,
      meal: null,
      walk: null,
    });
  }
  const applyCurve = (points: CurvePoint[] | null, key: "forecast" | "alt", withBand: boolean) => {
    if (!points) return;
    for (const point of points) {
      const index = dataEnd + point.minutesAhead / STEP_MIN;
      const slot = index - start;
      if (slot < 0 || slot >= rows.length) continue;
      const row = rows[slot]!;
      row[key] = toUnit(point.p50, unit);
      if (withBand) {
        const lo = toUnit(point.p10, unit);
        const hi = toUnit(point.p90, unit);
        row.bandBase = lo;
        row.band = Math.max(0, hi - lo);
      }
    }
  };
  applyCurve(curve, "forecast", true);
  applyCurve(comparison ?? null, "alt", false);
  if (curve && rows[dataEnd - start]) {
    const junction = rows[dataEnd - start]!;
    if (junction.glucose != null) junction.forecast = junction.glucose;
  }

  for (const meal of model.meals) {
    if (!meal.logged) continue;
    const index = Math.round(meal.min / STEP_MIN);
    const y = model.readings[index]?.glucose;
    if (y != null) place(rows, index, start, "meal", toUnit(y, unit));
  }
  for (const walk of model.walks) {
    const index = Math.round(walk.min / STEP_MIN);
    const y = model.readings[index]?.glucose;
    if (y != null) place(rows, index, start, "walk", toUnit(y, unit));
  }

  const low = displayThreshold(70, unit);
  const high = displayThreshold(180, unit);
  const values = rows.flatMap((row) =>
    [
      row.glucose,
      row.forecast,
      row.alt,
      row.bandBase,
      row.bandBase != null && row.band != null ? row.bandBase + row.band : null,
    ].filter((value): value is number => value != null),
  );
  const scale = clinicalScale(unit, values);

  return (
    <div className="h-64 w-full sm:h-80">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-line)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            interval={11}
            axisLine={false}
            tickLine={false}
          />
          <GlucoseAxis unit={unit} lo={scale.lo} hi={scale.hi} ticks={scale.ticks} />
          <Tooltip
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-line)",
              borderRadius: 12,
              color: "var(--color-ink)",
              fontSize: 13,
            }}
            formatter={(value, name) => {
              if (typeof value !== "number") return ["—", String(name)];
              return [unit === "mmol" ? value.toFixed(1) : String(Math.round(value)), String(name)];
            }}
          />
          <ReferenceLine
            y={low}
            stroke="var(--color-indigo)"
            strokeDasharray="4 4"
            label={{ value: "70", fill: "var(--color-indigo)", fontSize: 11 }}
          />
          <ReferenceLine
            y={high}
            stroke="var(--color-amber)"
            strokeDasharray="4 4"
            label={{ value: "180", fill: "var(--color-amber)", fontSize: 11 }}
          />
          <Area
            type="monotone"
            dataKey="bandBase"
            stackId="band"
            stroke="none"
            fill="transparent"
            legendType="none"
            name="Band floor"
          />
          <Area
            type="monotone"
            dataKey="band"
            stackId="band"
            stroke="none"
            fill="var(--color-teal)"
            fillOpacity={0.18}
            name="10–90% band"
          />
          <Line
            type="monotone"
            dataKey="glucose"
            name="Glucose"
            stroke="var(--color-ink)"
            strokeWidth={2.25}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="forecast"
            name="Forecast"
            stroke="var(--color-teal)"
            strokeWidth={2.25}
            strokeDasharray="5 4"
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
          {comparison ? (
            <Line
              type="monotone"
              dataKey="alt"
              name={comparisonName}
              stroke="var(--color-indigo)"
              strokeWidth={2.25}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          ) : null}
          <Scatter dataKey="meal" name="Meal" fill="var(--color-amber)" />
          <Scatter dataKey="walk" name="Walk" fill="var(--color-teal)" shape="triangle" />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AgpChart({
  bins,
  unit,
}: {
  bins: { minute: number; p5: number; p25: number; p50: number; p75: number; p95: number }[];
  unit: GlucoseUnit;
}) {
  const rows = bins.map((bin) => {
    const p5 = toUnit(bin.p5, unit);
    const p25 = toUnit(bin.p25, unit);
    const p50 = toUnit(bin.p50, unit);
    const p75 = toUnit(bin.p75, unit);
    const p95 = toUnit(bin.p95, unit);
    const hour = Math.floor(bin.minute / 60);
    const minute = bin.minute % 60;
    return {
      label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      floor: p5,
      outer: Math.max(0, p95 - p5),
      midFloor: p25,
      inner: Math.max(0, p75 - p25),
      median: p50,
    };
  });
  const low = displayThreshold(70, unit);
  const high = displayThreshold(180, unit);
  const scale = clinicalScale(
    unit,
    rows.flatMap((row) => [row.floor, row.floor + row.outer, row.median]),
  );
  return (
    <div className="h-64 w-full sm:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-line)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            interval={3}
            axisLine={false}
            tickLine={false}
          />
          <GlucoseAxis unit={unit} lo={scale.lo} hi={scale.hi} ticks={scale.ticks} />
          <Tooltip
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-line)",
              borderRadius: 12,
              fontSize: 13,
            }}
          />
          <ReferenceLine y={low} stroke="var(--color-indigo)" strokeDasharray="4 4" />
          <ReferenceLine y={high} stroke="var(--color-amber)" strokeDasharray="4 4" />
          <Area
            dataKey="floor"
            stackId="outer"
            stroke="none"
            fill="transparent"
            legendType="none"
          />
          <Area
            dataKey="outer"
            stackId="outer"
            stroke="none"
            fill="var(--color-teal)"
            fillOpacity={0.16}
            name="5–95%"
          />
          <Area
            dataKey="midFloor"
            stackId="inner"
            stroke="none"
            fill="transparent"
            legendType="none"
          />
          <Area
            dataKey="inner"
            stackId="inner"
            stroke="none"
            fill="var(--color-teal)"
            fillOpacity={0.32}
            name="25–75%"
          />
          <Line
            dataKey="median"
            name="Median"
            stroke="var(--color-ink)"
            strokeWidth={2.25}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export function NightChart({
  bins,
  unit,
}: {
  bins: { minute: number; p25: number; p50: number; p75: number; last: number | null }[];
  unit: GlucoseUnit;
}) {
  const rows = bins.map((bin) => {
    const p25 = toUnit(bin.p25, unit);
    const p50 = toUnit(bin.p50, unit);
    const p75 = toUnit(bin.p75, unit);
    const hour = Math.floor(bin.minute / 60);
    const minute = bin.minute % 60;
    return {
      label: `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
      floor: p25,
      band: Math.max(0, p75 - p25),
      median: p50,
      last: bin.last == null ? null : toUnit(bin.last, unit),
    };
  });
  const low = displayThreshold(70, unit);
  const high = displayThreshold(180, unit);
  const values = rows.flatMap((row) =>
    [row.floor, row.floor + row.band, row.median, row.last].filter(
      (value): value is number => value != null,
    ),
  );
  const scale = clinicalScale(unit, values);
  return (
    <div className="h-64 w-full sm:h-72">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={rows} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-line)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            interval={3}
            axisLine={false}
            tickLine={false}
          />
          <GlucoseAxis unit={unit} lo={scale.lo} hi={scale.hi} ticks={scale.ticks} />
          <Tooltip
            contentStyle={{
              background: "var(--color-surface)",
              border: "1px solid var(--color-line)",
              borderRadius: 12,
              fontSize: 13,
            }}
          />
          <ReferenceLine y={low} stroke="var(--color-indigo)" strokeDasharray="4 4" />
          <ReferenceLine y={high} stroke="var(--color-amber)" strokeDasharray="4 4" />
          <Area
            dataKey="floor"
            stackId="night"
            stroke="none"
            fill="transparent"
            legendType="none"
          />
          <Area
            dataKey="band"
            stackId="night"
            stroke="none"
            fill="var(--color-teal)"
            fillOpacity={0.22}
            name="25–75%"
          />
          <Line
            dataKey="median"
            name="Median"
            stroke="var(--color-ink)"
            strokeWidth={2.25}
            dot={false}
            isAnimationActive={false}
          />
          <Line
            dataKey="last"
            name="Latest morning"
            stroke="var(--color-indigo)"
            strokeWidth={2.25}
            dot={false}
            connectNulls={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
