import { useMemo } from "react";
import { getDraftModelOptionContext, resolveSelectedModelOptions } from "~/lib/modelOptions";
import { useGenerationStore } from "~/stores/generationStore";
import { useSettingsStore } from "~/stores/settingsStore";

/** Option context and resolved per-model options for the current gallery draft. */
export function useDraftModelOptions() {
  const models = useSettingsStore((s) => s.models);
  const styles = useSettingsStore((s) => s.styles);
  const characters = useSettingsStore((s) => s.characters);
  const modelSelections = useGenerationStore((s) => s.currentModelSelections);
  const rawOptions = useGenerationStore((s) => s.currentModelOptions);
  const manualReferenceCount = useGenerationStore((s) => s.currentReferenceImages.length);
  const styleId = useGenerationStore((s) => s.currentStyleId);
  const characterIds = useGenerationStore((s) => s.currentCharacterIds);

  return useMemo(() => {
    const context = getDraftModelOptionContext({
      models,
      modelSelections,
      manualReferenceCount,
      style: styleId ? styles.find((s) => s.id === styleId && s.enabled) : null,
      characters: characterIds
        .map((id) => characters.find((c) => c.id === id && c.enabled))
        .filter((c): c is NonNullable<typeof c> => c !== undefined),
    });
    return {
      context,
      rawOptions,
      resolved: resolveSelectedModelOptions(models, modelSelections, rawOptions, context),
    };
  }, [
    models,
    styles,
    characters,
    modelSelections,
    rawOptions,
    manualReferenceCount,
    styleId,
    characterIds,
  ]);
}
