import { Maximize } from "lucide-react";
import { RESOLUTIONS_LABELS, anyModelSupportsResolution } from "~/lib/models";
import { useGenerationStore } from "~/stores/generationStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { OptionHeader, SegmentedButtons } from "./OptionControls";

export function ResolutionSection() {
  const resolution = useGenerationStore((s) => s.currentResolution);
  const setResolution = useGenerationStore((s) => s.setResolution);
  const modelSelections = useGenerationStore((s) => s.currentModelSelections);
  const models = useSettingsStore((s) => s.models);

  // Derive selected model IDs from modelSelections (subscribing to the actual state)
  const selectedModels = Object.entries(modelSelections)
    .filter(([, count]) => count > 0)
    .map(([modelId]) => modelId);
  const pickerEnabled = anyModelSupportsResolution(models, selectedModels);

  return (
    <section>
      <OptionHeader icon={<Maximize className="h-4 w-4" />} title="Resolution" />
      <SegmentedButtons
        options={RESOLUTIONS_LABELS.map(([label, res]) => ({
          value: res,
          label,
          hint: `${res} resolution`,
        }))}
        value={resolution}
        onChange={setResolution}
        disabled={!pickerEnabled}
      />
    </section>
  );
}
