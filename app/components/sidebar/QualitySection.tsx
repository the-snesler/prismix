import { Sparkles } from "lucide-react";
import { QUALITIES, getQualityIntersection } from "~/lib/models";
import { useGenerationStore } from "~/stores/generationStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { OptionHeader, SteppedSlider } from "./OptionControls";

const QUALITY_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export function QualitySection() {
  const quality = useGenerationStore((s) => s.currentQuality);
  const setQuality = useGenerationStore((s) => s.setQuality);
  const modelSelections = useGenerationStore((s) => s.currentModelSelections);
  const models = useSettingsStore((s) => s.models);

  const selectedModels = Object.entries(modelSelections)
    .filter(([, count]) => count > 0)
    .map(([modelId]) => modelId);

  const supported = new Set(getQualityIntersection(models, selectedModels));
  const qualities = QUALITIES.filter((value) => supported.has(value));
  const selected =
    quality && qualities.includes(quality as (typeof qualities)[number]) ? quality : null;

  if (qualities.length === 0) return null;
  return (
    <section>
      <OptionHeader
        icon={<Sparkles className="h-4 w-4" />}
        title="Quality"
        value={selected ? QUALITY_LABELS[selected] : "Default"}
      />
      <SteppedSlider
        label="Quality"
        options={qualities.map((value) => ({ value, label: QUALITY_LABELS[value] }))}
        value={selected}
        onChange={setQuality}
      />
    </section>
  );
}
