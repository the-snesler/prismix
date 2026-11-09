import type {
  GenerationCostEstimate,
  ImageScorecard,
  ModelOptionValues,
  ScorecardCriterion,
} from "~/types";
import { SCORECARD_CRITERIA } from "./scorecard";

/** Slim, blob-free projection of a stored image — everything the stats page needs. */
export interface ImageStatRecord {
  id: string;
  modelId: string;
  modelName: string;
  createdAt: number;
  generationTimeMs: number | null;
  costUsd: number | null;
  costEstimate?: GenerationCostEstimate;
  aspectRatio: string | null;
  resolution: string | null;
  quality: string | null;
  modelOptions?: ModelOptionValues;
  megapixels: number;
  styleId: string | null;
  characterIds: string[];
  isFavorite: boolean;
  referenceCount: number;
  isEdit: boolean;
  isUpscale: boolean;
  usedVariations: boolean;
  prompt: string;
  scorecard?: ImageScorecard;
}

/** Structural subset shared by current and legacy IndexedDB image records. */
interface StatSourceRecord {
  id: string;
  modelId: string;
  modelName: string;
  createdAt: number;
  prompt: string;
  width: number;
  height: number;
  aspectRatio: string | null;
  resolution: string | null;
  referenceImageIds?: string[];
  quality?: string | null;
  modelOptions?: ModelOptionValues;
  generationTimeMs?: number;
  costEstimate?: GenerationCostEstimate;
  styleId?: string;
  characterIds?: string[];
  isFavorite?: boolean;
  parentGalleryItemIds?: string[];
  basePrompt?: string;
  scorecard?: ImageScorecard;
}

export function toImageStatRecord(record: StatSourceRecord): ImageStatRecord {
  return {
    id: record.id,
    modelId: record.modelId,
    modelName: record.modelName,
    createdAt: record.createdAt,
    generationTimeMs:
      typeof record.generationTimeMs === "number" && record.generationTimeMs > 0
        ? record.generationTimeMs
        : null,
    costUsd: typeof record.costEstimate?.usd === "number" ? record.costEstimate.usd : null,
    costEstimate: record.costEstimate,
    aspectRatio: record.aspectRatio ?? null,
    resolution: record.resolution ?? null,
    quality: record.quality ?? null,
    modelOptions: record.modelOptions,
    megapixels: ((record.width || 0) * (record.height || 0)) / 1_000_000,
    styleId: record.styleId ?? null,
    characterIds: record.characterIds ?? [],
    isFavorite: record.isFavorite === true,
    referenceCount: record.referenceImageIds?.length ?? 0,
    isEdit: (record.parentGalleryItemIds?.length ?? 0) > 0,
    isUpscale: record.modelName.endsWith("↑"),
    usedVariations: !!record.basePrompt && record.basePrompt !== record.prompt,
    prompt: record.prompt ?? "",
    scorecard: record.scorecard,
  };
}

// ---------------------------------------------------------------------------
// Ranges & time buckets

export type StatsRangeKey = "7d" | "30d" | "90d" | "1y" | "all";
export type Granularity = "day" | "week" | "month";

export const STATS_RANGES: Array<{ key: StatsRangeKey; label: string; days: number | null }> = [
  { key: "7d", label: "7D", days: 7 },
  { key: "30d", label: "30D", days: 30 },
  { key: "90d", label: "90D", days: 90 },
  { key: "1y", label: "1Y", days: 365 },
  { key: "all", label: "All", days: null },
];

const DAY_MS = 86_400_000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfBucket(ts: number, granularity: Granularity): number {
  const d = new Date(startOfDay(ts));
  if (granularity === "week") {
    // Monday-start weeks
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  } else if (granularity === "month") {
    d.setDate(1);
  }
  return d.getTime();
}

function nextBucket(ts: number, granularity: Granularity): number {
  const d = new Date(ts);
  if (granularity === "day") d.setDate(d.getDate() + 1);
  else if (granularity === "week") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  return d.getTime();
}

/** Local midnight that opens the range, or null for all-time. */
export function getRangeStart(rangeKey: StatsRangeKey, now = Date.now()): number | null {
  const days = STATS_RANGES.find((r) => r.key === rangeKey)?.days ?? null;
  return days == null ? null : startOfDay(now - (days - 1) * DAY_MS);
}

function pickGranularity(spanMs: number): Granularity {
  const days = spanMs / DAY_MS;
  if (days <= 35) return "day";
  if (days <= 200) return "week";
  return "month";
}

/** Local-calendar day number (days since epoch), immune to DST shifts. */
function dayNumber(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS;
}

function dayNumberToTimestamp(day: number): number {
  const d = new Date(day * DAY_MS);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();
}

// ---------------------------------------------------------------------------
// Model series (stable colors)

/** Max named series before folding into "Other" (palette has 8 slots; Other takes one). */
export const MAX_NAMED_SERIES = 7;
export const OTHER_SERIES_KEY = "other";

export interface ModelSeries {
  key: string; // "s0".."s6" | "other"
  slot: number | null; // palette slot, null = Other
  name: string;
  modelIds: string[];
}

/**
 * Assigns palette slots by all-time usage so a model keeps its color regardless of the
 * selected range (color follows the entity, never its rank within a filter).
 */
export function assignModelSeries(records: ImageStatRecord[]): {
  series: ModelSeries[];
  keyByModelId: Map<string, string>;
} {
  const counts = new Map<string, { name: string; count: number }>();
  for (const record of records) {
    const entry = counts.get(record.modelId) ?? { name: record.modelName, count: 0 };
    entry.count += 1;
    entry.name = record.modelName;
    counts.set(record.modelId, entry);
  }

  const ranked = [...counts.entries()].sort((a, b) => b[1].count - a[1].count);
  const series: ModelSeries[] = [];
  const keyByModelId = new Map<string, string>();
  const otherIds: string[] = [];

  // Only fold when it saves at least two models; otherwise give the 8th model its own slot.
  const namedLimit = ranked.length <= MAX_NAMED_SERIES + 1 ? ranked.length : MAX_NAMED_SERIES;
  ranked.forEach(([modelId, { name }], index) => {
    if (index < namedLimit) {
      const key = `s${index}`;
      series.push({ key, slot: index, name, modelIds: [modelId] });
      keyByModelId.set(modelId, key);
    } else {
      otherIds.push(modelId);
      keyByModelId.set(modelId, OTHER_SERIES_KEY);
    }
  });
  if (otherIds.length > 0) {
    series.push({ key: OTHER_SERIES_KEY, slot: null, name: "Other models", modelIds: otherIds });
  }

  return { series, keyByModelId };
}

// ---------------------------------------------------------------------------
// Aggregation

export interface TimelinePoint {
  bucket: number;
  images: number;
  spend: number;
  /** Per-series values, keyed `images_<seriesKey>` / `spend_<seriesKey>`. */
  [key: string]: number | string | undefined;
}

export interface ModelBreakdown {
  modelId: string;
  name: string;
  seriesKey: string;
  images: number;
  spend: number;
  costedImages: number;
  avgCost: number | null;
  favorites: number;
  timing: TimingSummary | null;
}

export interface TimingSummary {
  n: number;
  min: number;
  p25: number;
  median: number;
  p75: number;
  p90: number;
}

export interface CountEntry {
  key: string;
  count: number;
  spend: number;
}

export interface StatsSummary {
  granularity: Granularity;
  totals: {
    images: number;
    spend: number;
    costedImages: number;
    avgCost: number | null;
    medianTimeMs: number | null;
    favorites: number;
    edits: number;
    upscales: number;
    variations: number;
    withReferences: number;
    avgReferences: number;
    megapixels: number;
    activeDays: number;
    longestStreak: number;
    currentStreak: number;
    busiestDay: { day: number; count: number } | null;
    avgPromptWords: number;
    withCharacter: number;
    withStyle: number;
    models: number;
  };
  previous: { images: number; spend: number } | null;
  timeline: TimelinePoint[];
  models: ModelBreakdown[];
  characters: CountEntry[];
  styles: CountEntry[];
  aspectRatios: CountEntry[];
  resolutions: CountEntry[];
  /** [dayOfWeek (Mon=0)][hour] → count */
  heatmap: number[][];
  heatmapMax: number;
  topWords: Array<{ word: string; count: number }>;
}

export function computeStats(
  records: ImageStatRecord[],
  rangeKey: StatsRangeKey,
  keyByModelId: Map<string, string>,
  seriesKeys: string[],
  now = Date.now()
): StatsSummary {
  const rangeDays = STATS_RANGES.find((r) => r.key === rangeKey)?.days ?? null;
  const earliest = records.reduce((min, r) => Math.min(min, r.createdAt), now);
  const start = getRangeStart(rangeKey, now) ?? startOfDay(earliest);
  const granularity = pickGranularity(now - start);

  const inRange = records.filter((r) => r.createdAt >= start && r.createdAt <= now);

  // Previous equal-length window for deltas
  let previous: StatsSummary["previous"] = null;
  if (rangeDays != null) {
    const prevStart = start - rangeDays * DAY_MS;
    previous = { images: 0, spend: 0 };
    for (const r of records) {
      if (r.createdAt >= prevStart && r.createdAt < start) {
        previous.images += 1;
        previous.spend += r.costUsd ?? 0;
      }
    }
  }

  // Timeline skeleton (continuous, including empty buckets)
  const timeline: TimelinePoint[] = [];
  const bucketIndex = new Map<number, number>();
  for (let b = startOfBucket(start, granularity); b <= now; b = nextBucket(b, granularity)) {
    const point: TimelinePoint = { bucket: b, images: 0, spend: 0 };
    for (const key of seriesKeys) {
      point[`images_${key}`] = 0;
      point[`spend_${key}`] = 0;
    }
    bucketIndex.set(b, timeline.length);
    timeline.push(point);
  }

  const models = new Map<
    string,
    {
      name: string;
      images: number;
      spend: number;
      costedImages: number;
      favorites: number;
      times: number[];
    }
  >();
  const characters = new Map<string, CountEntry>();
  const styles = new Map<string, CountEntry>();
  const aspectRatios = new Map<string, CountEntry>();
  const resolutions = new Map<string, CountEntry>();
  const heatmap = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  const dayCounts = new Map<number, number>();
  const words = new Map<string, number>();
  const allTimes: number[] = [];

  const totals = {
    images: inRange.length,
    spend: 0,
    costedImages: 0,
    favorites: 0,
    edits: 0,
    upscales: 0,
    variations: 0,
    withReferences: 0,
    references: 0,
    megapixels: 0,
    promptWords: 0,
    withCharacter: 0,
    withStyle: 0,
  };

  const bump = (map: Map<string, CountEntry>, key: string, spend: number) => {
    const entry = map.get(key) ?? { key, count: 0, spend: 0 };
    entry.count += 1;
    entry.spend += spend;
    map.set(key, entry);
  };

  for (const r of inRange) {
    const cost = r.costUsd ?? 0;
    const seriesKey = keyByModelId.get(r.modelId) ?? OTHER_SERIES_KEY;

    // Totals
    if (r.costUsd != null) {
      totals.spend += cost;
      totals.costedImages += 1;
    }
    if (r.isFavorite) totals.favorites += 1;
    if (r.isEdit) totals.edits += 1;
    if (r.isUpscale) totals.upscales += 1;
    if (r.usedVariations) totals.variations += 1;
    if (r.referenceCount > 0) totals.withReferences += 1;
    totals.references += r.referenceCount;
    totals.megapixels += r.megapixels;
    if (r.generationTimeMs != null) allTimes.push(r.generationTimeMs);

    // Timeline
    const idx = bucketIndex.get(startOfBucket(r.createdAt, granularity));
    if (idx != null) {
      const point = timeline[idx];
      point.images += 1;
      point.spend += cost;
      point[`images_${seriesKey}`] = ((point[`images_${seriesKey}`] as number) ?? 0) + 1;
      point[`spend_${seriesKey}`] = ((point[`spend_${seriesKey}`] as number) ?? 0) + cost;
    }

    // Models
    const model = models.get(r.modelId) ?? {
      name: r.modelName,
      images: 0,
      spend: 0,
      costedImages: 0,
      favorites: 0,
      times: [],
    };
    model.images += 1;
    model.spend += cost;
    if (r.costUsd != null) model.costedImages += 1;
    if (r.isFavorite) model.favorites += 1;
    if (r.generationTimeMs != null) model.times.push(r.generationTimeMs);
    models.set(r.modelId, model);

    // Subjects & formats
    if (r.characterIds.length > 0) totals.withCharacter += 1;
    for (const id of r.characterIds) bump(characters, id, cost);
    if (r.styleId) {
      totals.withStyle += 1;
      bump(styles, r.styleId, cost);
    }
    if (!r.isUpscale) {
      bump(aspectRatios, r.aspectRatio ?? "Auto", cost);
      bump(resolutions, r.resolution ?? "Default", cost);
    }

    // Rhythm
    const date = new Date(r.createdAt);
    heatmap[(date.getDay() + 6) % 7][date.getHours()] += 1;
    const day = dayNumber(r.createdAt);
    dayCounts.set(day, (dayCounts.get(day) ?? 0) + 1);

    // Vocabulary
    if (!r.isUpscale && !r.isEdit) {
      const promptWords = tokenize(r.prompt);
      totals.promptWords += promptWords.length;
      for (const word of new Set(promptWords)) {
        if (word.length < 3 || STOPWORDS.has(word) || /^\d+$/.test(word)) continue;
        words.set(word, (words.get(word) ?? 0) + 1);
      }
    }
  }

  // Mark the top-most non-zero segment per bucket so only it gets rounded corners.
  for (const point of timeline) {
    for (const metric of ["images", "spend"] as const) {
      let top: string | undefined;
      for (const key of seriesKeys) {
        if ((point[`${metric}_${key}`] as number) > 0) top = key;
      }
      point[`top_${metric}`] = top;
    }
  }

  // Streaks & busiest day
  const days = [...dayCounts.keys()].sort((a, b) => a - b);
  let longestStreak = 0;
  let run = 0;
  for (let i = 0; i < days.length; i++) {
    run = i > 0 && days[i] === days[i - 1] + 1 ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
  }
  let currentStreak = 0;
  const today = dayNumber(now);
  // A streak is still "current" if the last active day was today or yesterday.
  for (let d = dayCounts.has(today) ? today : today - 1; dayCounts.has(d); d--) currentStreak++;

  let busiestDay: StatsSummary["totals"]["busiestDay"] = null;
  for (const [day, count] of dayCounts) {
    if (!busiestDay || count > busiestDay.count) busiestDay = { day, count };
  }
  if (busiestDay) {
    busiestDay = { day: dayNumberToTimestamp(busiestDay.day), count: busiestDay.count };
  }

  const nonEditImages = inRange.filter((r) => !r.isUpscale && !r.isEdit).length;

  return {
    granularity,
    totals: {
      images: totals.images,
      spend: totals.spend,
      costedImages: totals.costedImages,
      avgCost: totals.costedImages > 0 ? totals.spend / totals.costedImages : null,
      medianTimeMs: allTimes.length > 0 ? quantile(sorted(allTimes), 0.5) : null,
      favorites: totals.favorites,
      edits: totals.edits,
      upscales: totals.upscales,
      variations: totals.variations,
      withReferences: totals.withReferences,
      avgReferences: totals.images > 0 ? totals.references / totals.images : 0,
      megapixels: totals.megapixels,
      activeDays: dayCounts.size,
      longestStreak,
      currentStreak,
      busiestDay,
      avgPromptWords: nonEditImages > 0 ? totals.promptWords / nonEditImages : 0,
      withCharacter: totals.withCharacter,
      withStyle: totals.withStyle,
      models: models.size,
    },
    previous,
    timeline,
    models: [...models.entries()]
      .map(([modelId, m]) => {
        const times = sorted(m.times);
        return {
          modelId,
          name: m.name,
          seriesKey: keyByModelId.get(modelId) ?? OTHER_SERIES_KEY,
          images: m.images,
          spend: m.spend,
          costedImages: m.costedImages,
          avgCost: m.costedImages > 0 ? m.spend / m.costedImages : null,
          favorites: m.favorites,
          timing:
            times.length === 0
              ? null
              : {
                  n: times.length,
                  min: times[0],
                  p25: quantile(times, 0.25),
                  median: quantile(times, 0.5),
                  p75: quantile(times, 0.75),
                  p90: quantile(times, 0.9),
                },
        };
      })
      .sort((a, b) => b.images - a.images),
    characters: sortedEntries(characters),
    styles: sortedEntries(styles),
    aspectRatios: sortedEntries(aspectRatios),
    resolutions: sortedEntries(resolutions),
    heatmap,
    heatmapMax: Math.max(0, ...heatmap.flat()),
    topWords: [...words.entries()]
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 24)
      .map(([word, count]) => ({ word, count })),
  };
}

function sortedEntries(map: Map<string, CountEntry>): CountEntry[] {
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function sorted(values: number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function quantile(sortedValues: number[], q: number): number {
  const pos = (sortedValues.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

function tokenize(prompt: string): string[] {
  return prompt
    .toLowerCase()
    .replace(/\{\{|\}\}/g, " ")
    .split(/[^a-z0-9'-]+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter(Boolean);
}

const STOPWORDS = new Set(
  (
    "the and for with that this from into onto over under are was were has have had its it's " +
    "their there they them then than but not you your our out off all any can will would " +
    "should could each very just more most some such only also both what which while who " +
    "whom where when how about above below between through during before after again " +
    "against image picture photo make made show showing shows like being been does did " +
    "his her hers him she he its one two three use using used same other another these " +
    "those here near behind front back side top bottom left right lot lots way style " +
    "featuring feature features background foreground"
  ).split(/\s+/)
);

// ---------------------------------------------------------------------------
// Scorecards

export interface ModelScoreStats {
  modelId: string;
  modelName: string;
  seriesKey: string;
  ratedImages: number;
  totalImages: number;
  overallAverage: number;
  criterionAverages: Partial<Record<ScorecardCriterion, number>>;
}

export function buildModelScoreStats(
  records: ImageStatRecord[],
  keyByModelId: Map<string, string>
): ModelScoreStats[] {
  const grouped = new Map<
    string,
    {
      modelName: string;
      totalImages: number;
      ratedImages: number;
      scores: Partial<Record<ScorecardCriterion, number[]>>;
    }
  >();

  for (const record of records) {
    const group = grouped.get(record.modelId) ?? {
      modelName: record.modelName,
      totalImages: 0,
      ratedImages: 0,
      scores: {},
    };
    group.totalImages += 1;

    let rated = false;
    for (const { key } of SCORECARD_CRITERIA) {
      const value = record.scorecard?.scores[key];
      if (typeof value === "number") {
        (group.scores[key] ??= []).push(value);
        rated = true;
      }
    }
    if (rated) group.ratedImages += 1;
    grouped.set(record.modelId, group);
  }

  const results: ModelScoreStats[] = [];
  for (const [modelId, group] of grouped) {
    if (group.ratedImages === 0) continue;
    const criterionAverages: Partial<Record<ScorecardCriterion, number>> = {};
    const all: number[] = [];
    for (const { key } of SCORECARD_CRITERIA) {
      const values = group.scores[key];
      if (!values?.length) continue;
      criterionAverages[key] = average(values);
      all.push(...values);
    }
    results.push({
      modelId,
      modelName: group.modelName,
      seriesKey: keyByModelId.get(modelId) ?? OTHER_SERIES_KEY,
      ratedImages: group.ratedImages,
      totalImages: group.totalImages,
      overallAverage: average(all),
      criterionAverages,
    });
  }

  return results.sort(
    (a, b) => b.overallAverage - a.overallAverage || b.ratedImages - a.ratedImages
  );
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
