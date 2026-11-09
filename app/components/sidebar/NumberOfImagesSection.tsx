import { Images } from "lucide-react";
import { useEffect } from "react";
import { anyModelSupportsNumberOfImages, getMaxImagesPerRequest } from "~/lib/models";
import { useGenerationStore } from "~/stores/generationStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { OptionHeader, RangeSlider } from "./OptionControls";

export function NumberOfImagesSection() {
  const numberOfImages = useGenerationStore((s) => s.currentNumberOfImages);
  const setNumberOfImages = useGenerationStore((s) => s.setNumberOfImages);
  const modelSelections = useGenerationStore((s) => s.currentModelSelections);
  const models = useSettingsStore((s) => s.models);

  const selectedModels = Object.entries(modelSelections)
    .filter(([, count]) => count > 0)
    .map(([modelId]) => modelId);

  const enabled = anyModelSupportsNumberOfImages(models, selectedModels);
  const max = enabled ? getMaxImagesPerRequest(models, selectedModels) : 1;

  // Clamp to the current max when the selection changes.
  useEffect(() => {
    if (numberOfImages > max) setNumberOfImages(max);
  }, [max, numberOfImages, setNumberOfImages]);

  if (!enabled || max <= 1) return null;
  return (
    <section>
      <OptionHeader
        icon={<Images className="h-4 w-4" />}
        title="Images / call"
        value={numberOfImages}
      />
      <RangeSlider
        label="Images per call"
        min={1}
        max={max}
        value={Math.min(numberOfImages, max)}
        onChange={setNumberOfImages}
      />
    </section>
  );
}
