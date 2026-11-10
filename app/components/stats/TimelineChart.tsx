import {
  Bar,
  BarChart,
  CartesianGrid,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
  type TooltipContentProps,
} from "recharts";
import type { Granularity, ModelSeries, TimelinePoint } from "~/lib/stats";
import { ChartTooltip } from "./ChartTooltip";
import { seriesColor, useChartTheme } from "./chartTheme";
import { formatBucket, formatCount, formatMoney, formatMoneyAxis } from "./format";

interface TimelineChartProps {
  data: TimelinePoint[];
  series: ModelSeries[];
  metric: "images" | "spend";
  granularity: Granularity;
  height?: number;
}

/** Stacked columns per time bucket, one segment per model series. */
export function TimelineChart({
  data,
  series,
  metric,
  granularity,
  height = 240,
}: TimelineChartProps) {
  const theme = useChartTheme();
  const formatValue = metric === "spend" ? formatMoney : formatCount;

  const renderTooltip = ({ active, payload, label }: TooltipContentProps) => {
    if (!active || !payload?.length) return null;
    const point = payload[0].payload as TimelinePoint;
    const rows = [...series]
      .reverse() // match visual stacking order (top segment first)
      .map((s) => ({
        key: s.key,
        name: s.name,
        value: formatValue(point[`${metric}_${s.key}`] as number),
        color: seriesColor(theme, s.key),
        raw: point[`${metric}_${s.key}`] as number,
      }))
      .filter((row) => row.raw > 0);
    return (
      <ChartTooltip
        title={formatBucket(Number(label), granularity, true)}
        rows={rows}
        footer={
          <span>
            <span className="text-text-primary font-semibold">{formatValue(point[metric])}</span>{" "}
            total
            {metric === "spend" && point.images > 0 && (
              <span className="text-text-muted"> · {formatCount(point.images)} images</span>
            )}
          </span>
        }
      />
    );
  };

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 4, right: 4, bottom: 0, left: 0 }}
          barCategoryGap="22%"
        >
          <CartesianGrid vertical={false} stroke={theme.grid} />
          <XAxis
            dataKey="bucket"
            tickFormatter={(v) => formatBucket(v, granularity)}
            tick={{ fill: theme.tick, fontSize: 11 }}
            axisLine={{ stroke: theme.axis }}
            tickLine={false}
            minTickGap={20}
            tickMargin={6}
          />
          <YAxis
            tickFormatter={metric === "spend" ? formatMoneyAxis : formatCount}
            tick={{ fill: theme.tick, fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            allowDecimals={metric === "spend"}
            width={44}
          />
          <Tooltip
            cursor={{ fill: theme.cursor }}
            content={renderTooltip}
            isAnimationActive={false}
            wrapperStyle={{ outline: "none" }}
          />
          {series.map((s) => (
            <Bar
              key={s.key}
              dataKey={`${metric}_${s.key}`}
              name={s.name}
              stackId="stack"
              fill={seriesColor(theme, s.key)}
              maxBarSize={24}
              animationDuration={450}
              shape={(props: BarShapeProps) => {
                const isTop = (props.payload as TimelinePoint)[`top_${metric}`] === s.key;
                return (
                  <Rectangle
                    {...props}
                    radius={isTop ? [4, 4, 0, 0] : 0}
                    // Surface-colored stroke reads as a 2px gap between stacked segments
                    stroke={theme.surface}
                    strokeWidth={2}
                  />
                );
              }}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
