import type {
  ModelOptionId,
  ModelOptionSpec,
  ModelOptionValues,
  StoredCharacter,
  StoredModel,
  StoredStyle,
} from "~/types";
import { getStrictReferenceImageLimit } from "./models";
import { countKeptReferences } from "./referencePrecedence";

/**
 * Model-specific generation options.
 *
 * A model opts in by declaring `capabilities.options[id]` (which values/range it accepts).
 * This registry owns everything else: labels, control type, cost relevance, and how
 * options depend on each other and on the rest of the request.
 *
 * Raw values (what the user picked, per model) are never sent directly. They go through
 * `resolveModelOptions`, which drops unsupported/hidden/unavailable options and clamps
 * ranges. The resolved values are what get sent, saved, hashed, and priced.
 */

/** Request facts outside the option values that can make an option unavailable. */
export interface ModelOptionContext {
  /** References that will be sent (manual + style + character). */
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

interface BaseOptionDefinition {
  id: ModelOptionId;
  label: string;
  /** Include this option when matching past generations for cost estimates. */
  affectsCost: boolean;
  /** Only shown/sent when this returns true for the values resolved so far. */
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
}

export type ModelOptionDefinition = EnumOptionDefinition | RangeOptionDefinition;

const isGif = (values: ModelOptionValues) => values.outputFormat === "gif";

/** Display and resolution order. Options that others depend on must come first. */
export const MODEL_OPTION_DEFINITIONS: readonly ModelOptionDefinition[] = [
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
      referenceCount > 0 ? "SVG and GIF output aren't available with reference images." : null,
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
  const spec = model.capabilities.options?.[definition.id];
  return spec?.kind === definition.kind ? spec : undefined;
}

function clampToRange(value: number, spec: Extract<ModelOptionSpec, { kind: "range" }>) {
  const snapped = spec.min + Math.round((value - spec.min) / spec.step) * spec.step;
  return Math.min(spec.max, Math.max(spec.min, snapped));
}

export interface ModelOptionControlState {
  definition: ModelOptionDefinition;
  spec: ModelOptionSpec;
  /** Value to show in the control (raw if valid, otherwise the effective default). */
  value: string | number | null;
  unavailableReason: string | null;
}

/** The options to render for a model, in order, given its raw values. */
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

    const rawValue = raw?.[definition.id];
    let value: string | number | null;
    if (spec.kind === "range") {
      value = clampToRange(typeof rawValue === "number" ? rawValue : spec.default, spec);
    } else {
      const enumDefinition = definition as EnumOptionDefinition;
      value =
        typeof rawValue === "string" && spec.values.includes(rawValue)
          ? rawValue
          : (enumDefinition.defaultValue ?? null);
    }

    controls.push({
      definition,
      spec,
      value,
      unavailableReason: definition.unavailableReason?.(context) ?? null,
    });
  }

  return controls;
}

/** Values actually sent for this model. Missing keys mean "omit / API default". */
export function resolveModelOptions(
  model: StoredModel,
  raw: ModelOptionValues | undefined,
  context: ModelOptionContext
): ModelOptionValues {
  const resolved: ModelOptionValues = {};

  for (const definition of MODEL_OPTION_DEFINITIONS) {
    const spec = specFor(model, definition);
    if (!spec) continue;
    if (definition.unavailableReason?.(context)) continue;
    if (definition.visibleWhen && !definition.visibleWhen(resolved)) continue;

    const rawValue = raw?.[definition.id];
    if (spec.kind === "range") {
      resolved[definition.id] = clampToRange(
        typeof rawValue === "number" ? rawValue : spec.default,
        spec
      );
    } else if (
      typeof rawValue === "string" &&
      spec.values.includes(rawValue) &&
      rawValue !== (definition as EnumOptionDefinition).defaultValue
    ) {
      resolved[definition.id] = rawValue;
    }
  }

  return resolved;
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

export function hasModelOptions(model: StoredModel): boolean {
  return MODEL_OPTION_DEFINITIONS.some((definition) => specFor(model, definition));
}

/** Per-call image cap imposed by option values (e.g. SVG is one image per request). */
export function getOptionImagesPerRequestLimit(values: ModelOptionValues): number {
  return values.outputFormat === "svg" ? 1 : Infinity;
}

/**
 * Distance between a past generation's options and the requested ones, over options with
 * `affectsCost`. 0 = same cost-relevant settings; each differing option adds up to 1.
 */
export function modelOptionsCostDistance(
  model: StoredModel | undefined,
  actual: ModelOptionValues | undefined,
  requested: ModelOptionValues
): number {
  let distance = 0;
  for (const definition of MODEL_OPTION_DEFINITIONS) {
    if (!definition.affectsCost) continue;
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
 * Human-readable values, e.g. ["GIF", "9 frames"]. Omitted options are skipped unless
 * `costOnly` is set, in which case options supported by `model` with a named default
 * (e.g. "Standard") are spelled out so cost comparisons are explicit.
 */
export function describeModelOptions(
  values: ModelOptionValues | undefined,
  { costOnly = false, model }: { costOnly?: boolean; model?: StoredModel } = {}
): string[] {
  const parts: string[] = [];
  for (const definition of MODEL_OPTION_DEFINITIONS) {
    if (costOnly && !definition.affectsCost) continue;
    let value = values?.[definition.id];
    if (
      value === undefined &&
      costOnly &&
      definition.kind === "enum" &&
      model &&
      specFor(model, definition)
    ) {
      value = definition.defaultValue;
    }
    if (value === undefined) continue;
    if (definition.kind === "range") {
      if (typeof value === "number") parts.push(definition.formatValue(value));
    } else {
      const label = definition.valueLabels[String(value)] ?? String(value);
      parts.push(
        definition.control === "stepped" ? `${label} ${definition.label.toLowerCase()}` : label
      );
    }
  }
  return parts;
}
