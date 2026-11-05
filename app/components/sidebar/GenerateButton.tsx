import { Sparkles, Loader2, KeyRound, AlertTriangle } from "lucide-react";
import { useNavigate } from "react-router";
import { useGenerationStore } from "~/stores/generationStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { useImageGeneration } from "~/hooks/useImageGeneration";
import { useDraftModelOptions } from "~/hooks/useDraftModelOptions";
import { buildGenerationSignature } from "~/lib/generationSignature";
import { getModel, getStrictReferenceImageLimit } from "~/lib/models";
import { hasProviderAccess } from "~/lib/providers";
import { hasVariationSections } from "~/lib/promptVariations";
import { computeReferencePrecedence } from "~/lib/referencePrecedence";
import { Tooltip } from "~/components/ui/Tooltip";
import NumberFlow from "@number-flow/react";
import { GenerationCostPreview } from "./GenerationCostPreview";

export function GenerateButton() {
  const prompt = useGenerationStore((s) => s.currentPrompt);
  const modelSelections = useGenerationStore((s) => s.currentModelSelections);
  const lastSubmittedSignature = useGenerationStore((s) => s.lastSubmittedSignature);
  const activeGenerationSignatures = useGenerationStore((s) => s.activeGenerationSignatures);
  const aspectRatio = useGenerationStore((s) => s.currentAspectRatio);
  const resolution = useGenerationStore((s) => s.currentResolution);
  const referenceImages = useGenerationStore((s) => s.currentReferenceImages);
  const quality = useGenerationStore((s) => s.currentQuality);
  const numberOfImages = useGenerationStore((s) => s.currentNumberOfImages);
  const reuseSentPrompt = useGenerationStore((s) => s.reuseSentPrompt);
  const currentStyleId = useGenerationStore((s) => s.currentStyleId);
  const currentCharacterIds = useGenerationStore((s) => s.currentCharacterIds);
  const models = useSettingsStore((s) => s.models);
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const styles = useSettingsStore((s) => s.styles);
  const characters = useSettingsStore((s) => s.characters);
  const navigate = useNavigate();

  const { generate } = useImageGeneration();
  const { resolved: modelOptions } = useDraftModelOptions();

  const activeModels = Object.entries(modelSelections).filter(([, count]) => count > 0);
  const totalImages = activeModels.reduce((sum, [, count]) => sum + count, 0);

  const missingKeys = activeModels.some(([modelId]) => {
    const model = getModel(models, modelId);
    return model && !hasProviderAccess(apiKeys, model.provider);
  });

  const currentSignature = buildGenerationSignature({
    prompt,
    modelSelections,
    aspectRatio,
    resolution,
    referenceImages,
    quality,
    modelOptions,
    numberOfImages,
    styleId: currentStyleId,
    characterIds: currentCharacterIds,
    reuseSentPrompt,
  });

  const isLastSubmittedActive =
    lastSubmittedSignature !== null &&
    (activeGenerationSignatures[lastSubmittedSignature] ?? 0) > 0;

  const isLockedForCurrentParams =
    isLastSubmittedActive && lastSubmittedSignature === currentSignature;

  const variationsEnabled = useGenerationStore((s) => s.variationsEnabled);
  const variationsBlocking = variationsEnabled && !hasVariationSections(prompt);

  const canGenerate =
    prompt.trim().length > 0 && totalImages > 0 && !isLockedForCurrentParams && !variationsBlocking;

  const canClear = prompt.trim().length !== 0 || totalImages > 0;

  // Compute reference-drop warning
  const selectedStyle = currentStyleId
    ? (styles.find((s) => s.id === currentStyleId && s.enabled) ?? null)
    : null;
  const selectedCharacters = currentCharacterIds
    .map((id) => characters.find((c) => c.id === id && c.enabled))
    .filter((c): c is NonNullable<typeof c> => c !== undefined);
  const characterRefCount = selectedCharacters.reduce(
    (sum, c) => sum + c.referenceImageIds.length,
    0
  );
  const selectedModelIds = activeModels.map(([id]) => id);
  const strictLimit = getStrictReferenceImageLimit(models, selectedModelIds);
  const precedence = computeReferencePrecedence({
    manualCount: referenceImages.length,
    styleHasRef: Boolean(selectedStyle?.referenceImageId),
    characterRefCount,
    limit: strictLimit,
  });
  const totalDropped = precedence.totalDropped;

  const refWarningTooltip =
    totalDropped > 0
      ? (() => {
          const limit =
            strictLimit === null ? 0 : strictLimit === Infinity ? "unlimited" : strictLimit;
          const parts: string[] = [
            `Model${selectedModelIds.length > 1 ? "s" : ""} accept${selectedModelIds.length === 1 ? "s" : ""} ${limit} reference${limit === 1 ? "" : "s"}.`,
          ];
          if (precedence.droppedManual > 0)
            parts.push(
              `Dropping ${precedence.droppedManual} manual reference${precedence.droppedManual === 1 ? "" : "s"}.`
            );
          if (precedence.droppedStyle > 0) parts.push("Dropping style reference.");
          if (precedence.droppedCharacter > 0)
            parts.push(
              `Dropping ${precedence.droppedCharacter} character reference${precedence.droppedCharacter === 1 ? "" : "s"}.`
            );
          return parts.join(" ");
        })()
      : null;

  const handleGenerate = () => {
    if (missingKeys) {
      navigate("/app/settings");
      return;
    }
    if (canGenerate) {
      generate();
    }
  };

  const handleClear = () => {
    useGenerationStore.getState().resetDraft();
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="group relative flex-1">
        <div className="pointer-events-none absolute inset-0 rounded-lg bg-purple-800 transition group-hover:bg-purple-600"></div>
        <button
          onClick={handleGenerate}
          disabled={!canGenerate}
          className={`flex w-full items-center justify-center gap-2 rounded-lg border-2 px-4 py-3 font-medium transition-all ${
            canGenerate
              ? "-translate-y-1 border-purple-500 bg-purple-600 text-white shadow-lg hover:-translate-y-2 hover:border-purple-400 hover:bg-purple-500 active:translate-y-0"
              : "border-c-border bg-surface-overlay text-text-muted translate-y-0 cursor-not-allowed"
          }`}
        >
          {isLockedForCurrentParams ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Generating...
            </>
          ) : missingKeys ? (
            <>
              <KeyRound className="h-4 w-4" />
              Missing keys
            </>
          ) : variationsBlocking ? (
            <>
              <Sparkles className="h-4 w-4" />
              {"Add {{variations}}"}
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" />
              Generate
            </>
          )}
        </button>
      </div>
      {refWarningTooltip && (
        <div className="flex w-full justify-center">
          <Tooltip content={refWarningTooltip} placement="top" maxWidth="max-w-72">
            <span className="inline-flex cursor-default items-center gap-1 text-xs text-red-400">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {totalDropped} reference{totalDropped === 1 ? "" : "s"} will be dropped
            </span>
          </Tooltip>
        </div>
      )}
      <div className="flex w-full justify-center">
        <span className="text-text-tertiary text-xs">
          <NumberFlow
            value={totalImages}
            format={{ useGrouping: false }}
            transformTiming={{ duration: 300, easing: "ease-out" }}
            spinTiming={{ duration: 300, easing: "ease-out" }}
            opacityTiming={{ duration: 150, easing: "ease-out" }}
            willChange
          />
          {" pending"}
          {totalImages > 0 && (
            <>
              {" • "}
              <GenerationCostPreview
                models={models}
                modelSelections={modelSelections}
                aspectRatio={aspectRatio}
                resolution={resolution}
                quality={quality}
                modelOptions={modelOptions}
                numberOfImages={numberOfImages}
              />
            </>
          )}
          {" • "}
          <button
            onClick={handleClear}
            disabled={!canClear}
            className="disabled:text-text-tertiary hover: text-center text-red-400 hover:underline disabled:hover:cursor-not-allowed disabled:hover:no-underline"
          >
            Clear
          </button>
        </span>
      </div>
    </div>
  );
}
