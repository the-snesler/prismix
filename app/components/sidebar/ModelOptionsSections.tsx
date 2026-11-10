import { Accordion } from "@base-ui/react/accordion";
import { Box } from "lucide-react";
import SVG from "react-inlinesvg";
import { useDraftModelOptions } from "~/hooks/useDraftModelOptions";
import {
  describeModelOptions,
  getModelOptionControls,
  hasModelOptions,
  resolveModelOptions,
  type ModelOptionContext,
  type ModelOptionControlState,
} from "~/lib/modelOptions";
import { useGenerationStore } from "~/stores/generationStore";
import { useSettingsStore } from "~/stores/settingsStore";
import type { ModelOptionValues, StoredModel } from "~/types";
import { CollapsibleSection } from "./CollapsibleSection";
import { OptionHeader, RangeSlider, SegmentedButtons, SteppedSlider } from "./OptionControls";

/**
 * One collapsible section per selected model that has model-specific options, titled with
 * the model's name so it's clear the settings only apply to that part of the request.
 *
 * `editing`: the editor always sends its source image as a reference (plus any attached
 * references); styles and characters don't apply there.
 */
export function ModelOptionsSections({ editing = false }: { editing?: boolean }) {
  const models = useSettingsStore((s) => s.models);
  const modelSelections = useGenerationStore((s) => s.currentModelSelections);
  const editorReferenceCount = useGenerationStore((s) => s.currentReferenceImages.length) + 1;
  const draft = useDraftModelOptions();
  const context = editing ? { referenceCount: editorReferenceCount } : draft.context;

  const selected = Object.entries(modelSelections)
    .filter(([, count]) => count > 0)
    .map(([id]) => models.find((m) => m.id === id))
    .filter((m): m is StoredModel => !!m && hasModelOptions(m));

  if (selected.length === 0) return null;
  return (
    <>
      {selected.map((model) => (
        <Accordion.Root key={model.id} defaultValue={[`options:${model.id}`]}>
          <ModelOptionsSection model={model} raw={draft.rawOptions[model.id]} context={context} />
        </Accordion.Root>
      ))}
    </>
  );
}

function ModelOptionsSection({
  model,
  raw,
  context,
}: {
  model: StoredModel;
  raw: ModelOptionValues | undefined;
  context: ModelOptionContext;
}) {
  const setModelOption = useGenerationStore((s) => s.setModelOption);
  const controls = getModelOptionControls(model, raw, context);
  const summary = describeModelOptions(resolveModelOptions(model, raw, context), { model }).join(
    " · "
  );

  return (
    <CollapsibleSection
      value={`options:${model.id}`}
      icon={model.icon ? <SVG src={model.icon} className="h-4 w-4" /> : <Box className="h-4 w-4" />}
      title={model.name}
      tooltip={`These options only apply to ${model.name}.`}
      badge={
        summary && (
          <span className="text-text-muted mr-1 max-w-32 truncate text-[10px]">{summary}</span>
        )
      }
    >
      <div className="border-border-subtle mt-4 space-y-4 border-l pb-1 pl-3">
        {controls.map((control) => (
          <ModelOptionControl
            key={control.definition.id}
            control={control}
            onChange={(value) => setModelOption(model.id, control.definition.id, value)}
          />
        ))}
      </div>
    </CollapsibleSection>
  );
}

function ModelOptionControl({
  control,
  onChange,
}: {
  control: ModelOptionControlState;
  onChange: (value: string | number | undefined) => void;
}) {
  const { definition, spec, value, unavailableReason } = control;

  if (definition.kind === "range" && spec.kind === "range") {
    const numeric = typeof value === "number" ? value : spec.default;
    return (
      <div>
        <OptionHeader title={definition.label} value={definition.formatValue(numeric)} />
        <RangeSlider
          label={definition.label}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={numeric}
          onChange={onChange}
        />
      </div>
    );
  }

  if (definition.kind !== "enum" || spec.kind !== "enum") return null;
  const options = spec.values.map((v) => ({
    value: v,
    label: definition.valueLabels[v] ?? v,
    hint: definition.valueHints?.[v],
  }));
  const selected = typeof value === "string" ? value : null;
  const note = unavailableReason ?? (selected ? definition.valueNotes?.[selected] : undefined);

  return (
    <div>
      <OptionHeader
        title={definition.label}
        value={
          definition.control === "stepped"
            ? selected
              ? (definition.valueLabels[selected] ?? selected)
              : "Default"
            : undefined
        }
      />
      {definition.control === "stepped" ? (
        <SteppedSlider
          label={definition.label}
          options={options}
          value={selected}
          onChange={(v) => onChange(v ?? undefined)}
        />
      ) : (
        <SegmentedButtons
          options={options}
          value={selected}
          disabled={!!unavailableReason}
          onChange={(v) => onChange(v === definition.defaultValue ? undefined : v)}
        />
      )}
      {note && <p className="text-text-muted mt-1.5 text-[10px]">{note}</p>}
    </div>
  );
}
