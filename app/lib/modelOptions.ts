import type {
  DeclaredModelOptionId,
  ModelOptionId,
  ModelOptionSpec,
  ModelOptionValues,
  StoredCharacter,
  StoredModel,
  StoredStyle,
} from "~/types";
import { QUALITIES, getStrictReferenceImageLimit } from "./models";
import { countKeptReferences } from "./referencePrecedence";

/**
 * Per-model generation options.
 *
 * Each selected model that supports any of these gets its own sidebar section. Most
 * options are declared by the model in `capabilities.options[id]`; `quality` and
 * `numberOfImages` are derived from the model's existing capability fields. This registry
 * owns everything else: labels, control type, cost relevance, and how options depend on
 * each other and on the rest of the request.
 *
 * Raw values (what the user picked, per model) are never sent directly. They go through
 * `resolveModelOptions` (or `resolveModelSettings`), which drops unsupported, hidden and
 * unavailable options and clamps ranges. The resolved values are what get sent, saved,
 * hashed, and priced.
 */

/** Request facts outside the option values that can make an option unavailable. */
export interface ModelOptionContext {
  /** References that will be sent (manual + style + character, or the editor's source). */
  referenceCount: number;
}

/** Context for the gallery draft: references that survive precedence truncation. */
export function getDraftModelOptionContext(input: {
  models: StoredModel[];
  modelSelections: Record<string, number>;
  manualReferenceCount: number;
  style: StoredStyle | null | undefined;
  characters: StoredCharacter[];
}): ModelOptionContext {
  const selectedIds = Object.entries(input.modelSelections)
    .filter(([, count]) => count > 0)
    .map(([id]) => id);
  return {
    referenceCount: countKeptReferences({
      manualCount: input.manualReferenceCount,
      styleHasRef: !!input.style?.referenceImageId,
      characterRefCount: input.characters.reduce((sum, c) => sum + c.referenceImageIds.length, 0),
      limit: getStrictReferenceImageLimit(input.models, selectedIds),
    }),
  };
}

type RangeSpec = Extract<ModelOptionSpec, { kind: "range" }>;

interface BaseOptionDefinition {
  id: ModelOptionId;
  label: string;
  /**
   * Include this option when matching past generations for cost estimates. Options with
   * `requestField` are stored outside `modelOptions` and priced by their own field
   * (`GenerationCostPreview` ranks quality separately).
   */
  affectsCost: boolean;
  /**
   * Sent and saved as the request's own field of this name rather than inside
   * `modelOptions`. See `resolveModelSettings`.
   */
  requestField?: boolean;
  /** What this model accepts. Defaults to `capabilities.options[id]`. */
  getSpec?: (model: StoredModel) => ModelOptionSpec | undefined;
  /** Only shown/sent when this returns true for the model's other resolved values. */
  visibleWhen?: (values: ModelOptionValues) => boolean;
  /** Non-null when the option can't be used for this request; the UI shows the reason. */
  unavailableReason?: (context: ModelOptionContext) => string | null;
}

export interface EnumOptionDefinition extends BaseOptionDefinition {
  kind: "enum";
  /** `stepped`: slider with a leading "Default" stop. `segmented`: one button per value. */
  control: "stepped" | "segmented";
  valueLabels: Record<string, string>;
  valueHints?: Record<string, string>;
  /** Value equivalent to omitting the option. Never stored, sent, or hashed. */
  defaultValue?: string;
  /** Shown under the control when the given value is selected. */
  valueNotes?: Record<string, string>;
}

export interface RangeOptionDefinition extends BaseOptionDefinition {
  kind: "range";
  control: "slider";
  formatValue: (value: number) => string;
  /** Leave out of summaries while the value equals the model's default. */
  quietAtDefault?: boolean;
}

export type ModelOptionDefinition = EnumOptionDefinition | RangeOptionDefinition;

const isGif = (values: ModelOptionValues) => values.outputFormat === "gif";

/** Known qualities in `QUALITIES` order, then any model-specific values in their own order. */
function orderQualities(values: string[]): string[] {
  const rank = (value: string) => {
    const index = (QUALITIES as readonly string[]).indexOf(value);
    return index < 0 ? QUALITIES.length : index;
  };
  return values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => rank(a.value) - rank(b.value) || a.index - b.index)
    .map(({ value }) => value);
}

/** Display order. Visibility is resolved separately, so dependencies can come later. */
export const MODEL_OPTION_DEFINITIONS: readonly ModelOptionDefinition[] = [
  {
    id: "quality",
    kind: "enum",
    control: "stepped",
    label: "Quality",
    affectsCost: true,
    requestField: true,
    valueLabels: { low: "Low", medium: "Medium", high: "High", xhigh: "XHigh", max: "Max" },
    getSpec: ({ capabilities }) => {
      if (!capabilities.supportsQuality) return undefined;
      const values = orderQualities(capabilities.supportedQualities ?? ["low", "medium", "high"]);
      return values.length > 0 ? { kind: "enum", values } : undefined;
    },
  },
  {
    id: "numberOfImages",
    kind: "range",
    control: "slider",
    label: "Images / call",
    // The estimate is per image, multiplied by the number of outputs.
    affectsCost: false,
    requestField: true,
    quietAtDefault: true,
    formatValue: (value) => `${value} / call`,
    getSpec: ({ capabilities }) => {
      const max = capabilities.maxImagesPerRequest ?? 1;
      return capabilities.supportsNumberOfImages && max > 1
        ? { kind: "range", min: 1, max, step: 1, default: 1 }
        : undefined;
    },
    // The API requires n = 1 for SVG.
    visibleWhen: (values) => values.outputFormat !== "svg",
  },
  {
    id: "complexity",
    kind: "enum",
    control: "stepped",
    label: "Complexity",
    // OpenAI: "Adjusting complexity has no separate fee."
    affectsCost: false,
    valueLabels: { low: "Low", medium: "Medium", high: "High" },
  },
  {
    id: "outputFormat",
    kind: "enum",
    control: "segmented",
    label: "Output",
    affectsCost: true,
    defaultValue: "standard",
    valueLabels: { standard: "Standard", svg: "SVG", gif: "GIF" },
    valueHints: { standard: "Raster", svg: "Vector", gif: "Animated" },
    valueNotes: { svg: "SVG output returns one image per call." },
    // Only the generations endpoint can return SVG/GIF; references route to edits.
    unavailableReason: ({ referenceCount }) =>
      referenceCount > 0
        ? "SVG and GIF aren't available when editing or using reference images."
        : null,
  },
  {
    id: "gifFrameCount",
    kind: "range",
    control: "slider",
    label: "Frames",
    affectsCost: true,
    visibleWhen: isGif,
    formatValue: (value) => `${value} frames`,
  },
  {
    id: "gifFrameDurationMs",
    kind: "range",
    control: "slider",
    label: "Frame duration",
    affectsCost: false,
    visibleWhen: isGif,
    formatValue: (value) => `${value} ms`,
  },
];

export function getModelOptionDefinition(id: ModelOptionId): ModelOptionDefinition | undefined {
  return MODEL_OPTION_DEFINITIONS.find((definition) => definition.id === id);
}

function specFor(
  model: StoredModel,
  definition: ModelOptionDefinition
): ModelOptionSpec | undefined {
  const spec = definition.getSpec
    ? definition.getSpec(model)
    : model.capabilities.options?.[definition.id as DeclaredModelOptionId];
  return spec?.kind === definition.kind ? spec : undefined;
}

function clampToRange(value: number, spec: RangeSpec) {
  const snapped = spec.min + Math.round((value - spec.min) / spec.step) * spec.step;
  return Math.min(spec.max, Math.max(spec.min, snapped));
}

/** The value a control shows: the raw pick if valid, otherwise the effective default. */
function displayValue(
  definition: ModelOptionDefinition,
  spec: ModelOptionSpec,
  rawValue: string | number | undefined
): string | number | null {
  if (spec.kind === "range") {
    return clampToRange(typeof rawValue === "number" ? rawValue : spec.default, spec);
  }
  if (typeof rawValue === "string" && spec.values.includes(rawValue)) return rawValue;
  return (definition as EnumOptionDefinition).defaultValue ?? null;
}

/** Valid, available values, before visibility rules (which can depend on each other). */
function resolveIgnoringVisibility(
  model: StoredModel,
  raw: ModelOptionValues | undefined,
  context: ModelOptionContext
): ModelOptionValues {
  const values: ModelOptionValues = {};
  for (const definition of MODEL_OPTION_DEFINITIONS) {
    const spec = specFor(model, definition);
    if (!spec || definition.unavailableReason?.(context)) continue;
    const value = displayValue(definition, spec, raw?.[definition.id]);
    // Enum defaults (e.g. "standard") are the same as omitting the option.
    if (value !== null && value !== (definition as EnumOptionDefinition).defaultValue) {
      values[definition.id] = value;
    }
  }
  return values;
}

/** Drop options hidden by other values, repeating until hiding one hides no others. */
function applyVisibility(values: ModelOptionValues): ModelOptionValues {
  let current = values;
  for (;;) {
    const next: ModelOptionValues = {};
    for (const definition of MODEL_OPTION_DEFINITIONS) {
      const value = current[definition.id];
      if (value === undefined) continue;
      if (definition.visibleWhen && !definition.visibleWhen(current)) continue;
      next[definition.id] = value;
    }
    if (Object.keys(next).length === Object.keys(current).length) return next;
    current = next;
  }
}

/** Values actually used for this model. Missing keys mean "omit / API default". */
export function resolveModelOptions(
  model: StoredModel,
  raw: ModelOptionValues | undefined,
  context: ModelOptionContext
): ModelOptionValues {
  return applyVisibility(resolveIgnoringVisibility(model, raw, context));
}

export interface ModelOptionControlState {
  definition: ModelOptionDefinition;
  spec: ModelOptionSpec;
  value: string | number | null;
  unavailableReason: string | null;
}

/** The options to render for a model, in display order, given its raw values. */
export function getModelOptionControls(
  model: StoredModel,
  raw: ModelOptionValues | undefined,
  context: ModelOptionContext
): ModelOptionControlState[] {
  const resolved = resolveModelOptions(model, raw, context);
  const controls: ModelOptionControlState[] = [];

  for (const definition of MODEL_OPTION_DEFINITIONS) {
    const spec = specFor(model, definition);
    if (!spec) continue;
    if (definition.visibleWhen && !definition.visibleWhen(resolved)) continue;
    controls.push({
      definition,
      spec,
      value: displayValue(definition, spec, raw?.[definition.id]),
      unavailableReason: definition.unavailableReason?.(context) ?? null,
    });
  }

  return controls;
}

/** Resolve options for every selected model. Models without options map to `{}`. */
export function resolveSelectedModelOptions(
  models: StoredModel[],
  modelSelections: Record<string, number>,
  rawByModel: Record<string, ModelOptionValues>,
  context: ModelOptionContext
): Record<string, ModelOptionValues> {
  const result: Record<string, ModelOptionValues> = {};
  for (const [modelId, count] of Object.entries(modelSelections)) {
    if (count <= 0) continue;
    const model = models.find((m) => m.id === modelId);
    if (model) result[modelId] = resolveModelOptions(model, rawByModel[modelId], context);
  }
  return result;
}

/** What one task for this model sends: request fields plus the provider-specific rest. */
export interface ModelSettings {
  quality: string | null;
  numberOfImages: number;
  /** Declared options only; this is what's sent as `modelOptions` and saved on images. */
  modelOptions: ModelOptionValues;
}

/** Split resolved values into the request's own fields and `modelOptions`. */
export function toModelSettings(resolved: ModelOptionValues | undefined): ModelSettings {
  const modelOptions: ModelOptionValues = {};
  for (const definition of MODEL_OPTION_DEFINITIONS) {
    const value = resolved?.[definition.id];
    if (value !== undefined && !definition.requestField) modelOptions[definition.id] = value;
  }
  return {
    quality: typeof resolved?.quality === "string" ? resolved.quality : null,
    numberOfImages: typeof resolved?.numberOfImages === "number" ? resolved.numberOfImages : 1,
    modelOptions,
  };
}

export function resolveModelSettings(
  model: StoredModel,
  raw: ModelOptionValues | undefined,
  context: ModelOptionContext
): ModelSettings {
  return toModelSettings(resolveModelOptions(model, raw, context));
}

/** Rebuild raw per-model values from a saved image (for "reuse prompt"). */
export function modelOptionsFromSaved(saved: {
  quality?: string | null;
  modelOptions?: ModelOptionValues;
}): ModelOptionValues {
  return { ...saved.modelOptions, ...(saved.quality ? { quality: saved.quality } : {}) };
}

export function hasModelOptions(model: StoredModel): boolean {
  return MODEL_OPTION_DEFINITIONS.some((definition) => specFor(model, definition));
}

/**
 * Distance between a past generation's `modelOptions` and the requested ones, over
 * options with `affectsCost` (excluding `requestField` options, which callers rank
 * themselves). 0 = same cost-relevant settings; each differing option adds up to 1.
 */
export function modelOptionsCostDistance(
  model: StoredModel | undefined,
  actual: ModelOptionValues | undefined,
  requested: ModelOptionValues
): number {
  let distance = 0;
  for (const definition of MODEL_OPTION_DEFINITIONS) {
    if (!definition.affectsCost || definition.requestField) continue;
    const fallback = definition.kind === "enum" ? definition.defaultValue : undefined;
    const a = actual?.[definition.id] ?? fallback;
    const b = requested[definition.id] ?? fallback;
    if (a === b) continue;

    const spec = model ? specFor(model, definition) : undefined;
    if (spec?.kind === "range" && typeof a === "number" && typeof b === "number") {
      distance += Math.abs(a - b) / Math.max(1, spec.max - spec.min);
    } else {
      distance += 1;
    }
  }
  return distance;
}

/**
 * Human-readable values, e.g. ["High quality", "GIF", "9 frames"].
 *
 * With `costOnly`, only `modelOptions` entries with `affectsCost` are described, and
 * options `model` supports that have a named default (e.g. "Standard") are spelled out
 * so cost comparisons are explicit.
 */
export function describeModelOptions(
  values: ModelOptionValues | undefined,
  { costOnly = false, model }: { costOnly?: boolean; model?: StoredModel } = {}
): string[] {
  const parts: string[] = [];
  for (const definition of MODEL_OPTION_DEFINITIONS) {
    if (costOnly && (!definition.affectsCost || definition.requestField)) continue;
    const spec = model ? specFor(model, definition) : undefined;
    let value = values?.[definition.id];
    if (value === undefined && costOnly && definition.kind === "enum" && spec) {
      value = definition.defaultValue;
    }
    if (value === undefined) continue;

    if (definition.kind === "range") {
      if (typeof value !== "number") continue;
      if (definition.quietAtDefault && spec?.kind === "range" && value === spec.default) continue;
      parts.push(definition.formatValue(value));
    } else {
      const label = definition.valueLabels[String(value)] ?? String(value);
      parts.push(
        definition.control === "stepped" ? `${label} ${definition.label.toLowerCase()}` : label
      );
    }
  }
  return parts;
}
