import { useEffect, useMemo, useState } from "react";
import { Info } from "lucide-react";
import NumberFlow from "@number-flow/react";
import { Tooltip } from "~/components/ui/Tooltip";
import { getImageStatRecords } from "~/lib/db";
import { getOpenAIImagePixelCount } from "~/lib/openaiImageSize";
import {
  aspectRatioDistance,
  doesModelSupportAspectRatio,
  QUALITIES,
  RESOLUTIONS_LABELS,
} from "~/lib/models";
import {
  describeModelOptions,
  getOptionImagesPerRequestLimit,
  modelOptionsCostDistance,
} from "~/lib/modelOptions";
import { type ImageStatRecord } from "~/lib/stats";
import { formatUsd, getAspectRatioValue } from "~/lib/util";
import { useGalleryStore } from "~/stores/galleryStore";
import type { AspectRatio, ModelOptionValues, Resolution, StoredModel } from "~/types";

// Unknown/default values are furthest away from a specific setting.
function parameterDistance(
  actual: string | null,
  requested: string | null,
  values: readonly string[]
) {
  if (actual === requested) return 0;
  const actualIndex = values.indexOf(actual ?? "");
  const requestedIndex = values.indexOf(requested ?? "");
  return actualIndex < 0 || requestedIndex < 0
    ? values.length
    : Math.abs(actualIndex - requestedIndex);
}

function costAspectRatioDistance(
  model: StoredModel | undefined,
  record: ImageStatRecord,
  aspectRatio: AspectRatio | null,
  resolution: Resolution | null
) {
  if (!record.aspectRatio || !aspectRatio) return record.aspectRatio === aspectRatio ? 0 : Infinity;
  if (model?.provider === "openai") {
    const actualPixels = getOpenAIImagePixelCount(
      model.id,
      record.aspectRatio,
      record.resolution as Resolution | null
    );
    const requestedPixels = getOpenAIImagePixelCount(model.id, aspectRatio, resolution);
    return actualPixels && requestedPixels
      ? aspectRatioDistance(actualPixels, requestedPixels)
      : Infinity;
  }
  const actual = getAspectRatioValue(record.aspectRatio);
  const requested = getAspectRatioValue(aspectRatio);
  return aspectRatioDistance(Math.max(actual, 1 / actual), Math.max(requested, 1 / requested));
}

interface Props {
  models: StoredModel[];
  modelSelections: Record<string, number>;
  aspectRatio: AspectRatio | null;
  resolution: Resolution;
  quality: string | null;
  /** Resolved options per selected model. */
  modelOptions: Record<string, ModelOptionValues>;
  numberOfImages: number;
}

export function GenerationCostPreview({
  models,
  modelSelections,
  aspectRatio,
  resolution,
  quality,
  modelOptions,
  numberOfImages,
}: Props) {
  const totalCount = useGalleryStore((s) => s.totalCount);
  const [records, setRecords] = useState<ImageStatRecord[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // Read all saved costs, including images outside the gallery's loaded page.
  useEffect(() => {
    let canceled = false;
    setLoadFailed(false);
    getImageStatRecords().then(
      (history) => {
        if (!canceled) setRecords(history);
      },
      () => {
        if (!canceled) setLoadFailed(true);
      }
    );
    return () => {
      canceled = true;
    };
  }, [totalCount]);

  const estimates = useMemo(
    () =>
      Object.entries(modelSelections)
        .filter(([, count]) => count > 0)
        .map(([modelId, count]) => {
          const model = models.find((m) => m.id === modelId);
          const taskResolution = model?.capabilities.supportsResolution ? resolution : null;
          const taskQuality = model?.capabilities.supportsQuality ? quality : null;
          const taskAspectRatio =
            model && aspectRatio && doesModelSupportAspectRatio(model, aspectRatio)
              ? aspectRatio
              : null;
          const taskOptions = modelOptions[modelId] ?? {};
          const outputs =
            count *
            (model?.capabilities.supportsNumberOfImages
              ? Math.max(
                  1,
                  Math.min(
                    numberOfImages,
                    model.capabilities.maxImagesPerRequest ?? 1,
                    getOptionImagesPerRequestLimit(taskOptions)
                  )
                )
              : 1);
          const candidates = (records ?? []).filter(
            (r) =>
              r.modelId === modelId &&
              r.costUsd !== null &&
              Number.isFinite(r.costUsd) &&
              r.costUsd >= 0
          );
          const scored = candidates.map((record) => ({
            record,
            distance: [
              modelOptionsCostDistance(model, record.modelOptions, taskOptions),
              parameterDistance(
                record.resolution,
                taskResolution,
                RESOLUTIONS_LABELS.map(([, value]) => value)
              ),
              parameterDistance(record.quality, taskQuality, QUALITIES),
              costAspectRatioDistance(model, record, taskAspectRatio, taskResolution),
            ],
          }));
          // Cost-affecting model options (e.g. GIF vs still) win over resolution; resolution
          // wins over quality; quality wins over aspect ratio, regardless of distance.
          scored.sort(
            (a, b) =>
              a.distance[0] - b.distance[0] ||
              a.distance[1] - b.distance[1] ||
              a.distance[2] - b.distance[2] ||
              a.distance[3] - b.distance[3]
          );
          const closest = scored[0]?.distance;
          const matches = scored
            .filter((sample) =>
              sample.distance.every((distance, index) => distance === closest?.[index])
            )
            .map((sample) => sample.record);
          const similar = closest?.some((distance) => distance > 0) ?? false;
          const matchedSettings = new Map<string, number>();
          for (const record of matches) {
            const setting = [
              record.resolution ?? "default resolution",
              record.quality ?? "default quality",
              record.aspectRatio ?? "auto aspect ratio",
              ...describeModelOptions(record.modelOptions, { costOnly: true, model }),
            ].join(" + ");
            matchedSettings.set(setting, (matchedSettings.get(setting) ?? 0) + 1);
          }
          const usd = matches.length
            ? (matches.reduce((sum, r) => sum + r.costUsd!, 0) / matches.length) * outputs
            : null;
          return {
            modelId,
            name: model?.name ?? modelId,
            outputs,
            usd,
            samples: matches.length,
            similar,
            matchedSettings,
          };
        }),
    [
      records,
      models,
      modelSelections,
      aspectRatio,
      resolution,
      quality,
      modelOptions,
      numberOfImages,
    ]
  );

  if (!estimates.length) return null;
  const priced = estimates.filter((e) => e.usd !== null);
  const partial = priced.length < estimates.length;
  const total = priced.reduce((sum, e) => sum + e.usd!, 0);
  const similar = estimates.some((e) => e.similar);

  return (
    <Tooltip
      placement="top"
      maxWidth="max-w-80"
      content={
        <div className="space-y-2">
          <p>
            Estimated cost based only on past generations with the same model, and similar output
            options, resolution, quality, and aspect ratio. Excludes rewriting, variation, and
            reference costs. Actual cost may vary.
          </p>
          {estimates.map((e) => (
            <div key={e.modelId}>
              <p className="text-text-primary">
                {e.name} × {e.outputs}: {e.usd === null ? "unavailable" : formatUsd(e.usd)}
              </p>
              {e.similar ? (
                [...e.matchedSettings].map(([setting, count]) => (
                  <p key={setting} className="text-[10px] text-red-400">
                    Based on {count} generation{count === 1 ? "" : "s"} at {setting}.
                  </p>
                ))
              ) : (
                <p className="text-text-muted text-[10px]">
                  {e.samples
                    ? `Based on ${e.samples} matching generation${e.samples === 1 ? "" : "s"}.`
                    : "No priced generations for this model."}
                </p>
              )}
            </div>
          ))}
          {loadFailed && <p>Could not load saved pricing history.</p>}
        </div>
      }
    >
      <span className="inline-flex cursor-help items-center gap-1 align-middle">
        {loadFailed || records === null || partial ? (
          "$???"
        ) : (
          <NumberFlow
            value={total}
            prefix="~"
            suffix={similar ? "?" : undefined}
            format={{
              style: "currency",
              currency: "USD",
              minimumFractionDigits: total < 0.01 ? 4 : 2,
              maximumFractionDigits: total < 0.01 ? 4 : 2,
            }}
            transformTiming={{ duration: 300, easing: "ease-out" }}
            spinTiming={{ duration: 300, easing: "ease-out" }}
            opacityTiming={{ duration: 150, easing: "ease-out" }}
          />
        )}
        <Info className="text-text-muted hover:text-text-tertiary h-3 w-3 transition-colors" />
      </span>
    </Tooltip>
  );
}
