import { ArrowUp, ImagePlus, Loader2, ScanSearch, Sparkles, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
} from "@dnd-kit/sortable";
import { useEditorStore } from "~/stores/editorStore";
import { useEditorGeneration } from "~/hooks/useEditorGeneration";
import { useImproveText } from "~/hooks/useImproveText";
import { useGalleryStore } from "~/stores/galleryStore";
import { useGenerationStore } from "~/stores/generationStore";
import { useLightboxStore } from "~/stores/lightboxStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { anyModelSupportsReferenceImages, getStrictReferenceImageLimit } from "~/lib/models";
import { callTextModel, isTextModelAvailable } from "~/lib/textModel";
import { ELABORATE_PROMPT_SYSTEM, REVERSE_PROMPT_SYSTEM } from "~/lib/prompts";
import { loadImageBlob, saveReferenceImage } from "~/lib/db";
import { generateContextBrief, getSourceTurnBrief } from "~/lib/contextBrief";
import { Tooltip } from "../ui/Tooltip";
import { ReferenceImageMarkupOverlay } from "../reference/ReferenceImageMarkupOverlay";
import { SortableReferenceImage } from "../reference/SortableReferenceImage";

interface EditorInputBarProps {
  /** Called when user pastes/drops an image and no source is set yet */
  onSourceFile?: (file: File) => void;
}

export function EditorInputBar({ onSourceFile }: EditorInputBarProps) {
  const instruction = useEditorStore((s) => s.instruction);
  const setInstruction = useEditorStore((s) => s.setInstruction);
  const instructionBasePrompt = useEditorStore((s) => s.instructionBasePrompt);
  const setInstructionBasePrompt = useEditorStore((s) => s.setInstructionBasePrompt);
  const sourceBlob = useEditorStore((s) => s.sourceBlob);
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const isGenerating = useEditorStore((s) => s.isGenerating);
  const setIsGenerating = useEditorStore((s) => s.setIsGenerating);
  const isAnalyzing = useEditorStore((s) => s.isAnalyzing);
  const setAnalyzing = useEditorStore((s) => s.setAnalyzing);
  const setAnalysisResult = useEditorStore((s) => s.setAnalysisResult);
  const addTurn = useEditorStore((s) => s.addTurn);
  const addItemToTurn = useEditorStore((s) => s.addItemToTurn);
  const selectItem = useEditorStore((s) => s.selectItem);
  const turns = useEditorStore((s) => s.turns);

  const referenceImages = useEditorStore((s) => s.referenceImages);
  const addReferenceImage = useEditorStore((s) => s.addReferenceImage);
  const removeReferenceImage = useEditorStore((s) => s.removeReferenceImage);
  const replaceReferenceImage = useEditorStore((s) => s.replaceReferenceImage);
  const reorderReferenceImages = useEditorStore((s) => s.reorderReferenceImages);
  const openLightbox = useLightboxStore((s) => s.openLightbox);

  const refDndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleRefDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (over && active.id !== over.id) {
        reorderReferenceImages(active.id as string, over.id as string);
      }
    },
    [reorderReferenceImages]
  );

  const modelSelections = useGenerationStore((s) => s.currentModelSelections);
  const aspectRatio = useGenerationStore((s) => s.currentAspectRatio);
  const resolution = useGenerationStore((s) => s.currentResolution);
  const modelOptions = useGenerationStore((s) => s.currentModelOptions);
  const models = useSettingsStore((s) => s.models);

  const sourcePrompt = useEditorStore((s) => s.sourcePrompt);
  const sourceGalleryItemId = useEditorStore((s) => s.sourceGalleryItemId);
  const contextInjectionEnabled = useSettingsStore((s) => s.editorContextInjectionEnabled);
  const setTurnSentInstruction = useEditorStore((s) => s.setTurnSentInstruction);

  const { generateEdit } = useEditorGeneration();

  const [isDragOver, setIsDragOver] = useState(false);
  const [contextBriefDismissed, setContextBriefDismissed] = useState(false);
  const [editingReferenceId, setEditingReferenceId] = useState<string | null>(null);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const supportsFieldSizing = useMemo(() => {
    if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return false;
    return CSS.supports("field-sizing", "content");
  }, []);

  useLayoutEffect(() => {
    if (supportsFieldSizing) return;
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [instruction, supportsFieldSizing]);

  // Reset brief dismissal when the selected image changes
  useEffect(() => {
    setContextBriefDismissed(false);
  }, [selectedItemId]);

  // Context brief from the turn that produced the currently selected image
  const contextBrief = useMemo(
    () => getSourceTurnBrief(turns, selectedItemId),
    [turns, selectedItemId]
  );

  // Active model names for chip display
  const activeModelNames = useMemo(() => {
    return Object.entries(modelSelections)
      .filter(([, count]) => count > 0)
      .map(([modelId]) => {
        const model = models.find((m) => m.id === modelId);
        return model?.name ?? modelId;
      });
  }, [modelSelections, models]);

  const modelChipLabel = useMemo(() => {
    if (activeModelNames.length === 0) return "No models";
    if (activeModelNames.length === 1) return activeModelNames[0];
    return `${activeModelNames[0]} +${activeModelNames.length - 1}`;
  }, [activeModelNames]);

  const selectedModelIds = useMemo(
    () =>
      Object.entries(modelSelections)
        .filter(([, count]) => count > 0)
        .map(([modelId]) => modelId),
    [modelSelections]
  );

  const referenceEnabled = anyModelSupportsReferenceImages(models, selectedModelIds);
  const editingReference = editingReferenceId
    ? (referenceImages.find((img) => img.id === editingReferenceId) ?? null)
    : null;

  const referenceLimit = useMemo(() => {
    const limit = getStrictReferenceImageLimit(models, selectedModelIds);
    if (limit === null) return 0;
    // Source always takes 1 slot, additional references limited to limit - 1
    return limit === Infinity ? Infinity : Math.max(0, limit - 1);
  }, [models, selectedModelIds]);

  const canAttachMore = referenceEnabled && referenceImages.length < referenceLimit;

  const hasSource = sourceBlob !== null;
  const canSubmit =
    hasSource && instruction.trim().length > 0 && !isAnalyzing && selectedModelIds.length > 0;

  // Resolve current canvas blob. Rejects if the selected gallery image was deleted.
  const getCanvasBlob = useCallback(async (): Promise<Blob | null> => {
    if (selectedItemId) {
      const item = useGalleryStore.getState().items.find((i) => i.id === selectedItemId);
      if (item && item.status === "completed") return loadImageBlob(item);
    }
    return sourceBlob;
  }, [selectedItemId, sourceBlob]);

  const addFiles = useCallback(
    (files: File[]) => {
      if (!referenceEnabled) return;
      const imageFiles = files.filter((f) => f.type.startsWith("image/"));
      const currentCount = useEditorStore.getState().referenceImages.length;
      const slotsAvailable =
        referenceLimit === Infinity ? imageFiles.length : referenceLimit - currentCount;
      const toAdd = imageFiles.slice(0, Math.max(0, slotsAvailable));
      for (const file of toAdd) {
        addReferenceImage({
          id: crypto.randomUUID(),
          blob: file,
          url: URL.createObjectURL(file),
          name: file.name,
        });
      }
    },
    [addReferenceImage, referenceEnabled, referenceLimit]
  );

  const addGalleryImage = useCallback(
    (imageData: string) => {
      if (!referenceEnabled) return;
      try {
        const { imageId, blob, name } = JSON.parse(imageData) as {
          imageId?: string;
          blob?: string;
          name?: string;
        };
        const galleryItems = useGalleryStore.getState().items;

        const addFromBlobUrl = () => {
          if (typeof blob !== "string") return;
          fetch(blob)
            .then((res) => res.blob())
            .then((blobData) => {
              addReferenceImage({
                id: crypto.randomUUID(),
                blob: blobData,
                url: URL.createObjectURL(blobData),
                name: name || "Gallery image",
              });
            });
        };

        if (imageId) {
          const galleryItem = galleryItems.find((item) => item.id === imageId);
          if (galleryItem && galleryItem.status === "completed") {
            loadImageBlob(galleryItem)
              .then((original) => {
                addReferenceImage({
                  id: crypto.randomUUID(),
                  blob: original,
                  url: URL.createObjectURL(original),
                  name: name || "Gallery image",
                  sourceGalleryItemId: imageId,
                });
              })
              // Image deleted meanwhile: fall back to the payload's blob URL, if any.
              .catch(addFromBlobUrl);
            return;
          }
        }

        addFromBlobUrl();
      } catch {
        // Ignore invalid drag payloads
      }
    },
    [addReferenceImage, referenceEnabled]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (!referenceEnabled || !hasSource) return;

      const imageData = e.dataTransfer.getData("application/json");
      if (imageData) addGalleryImage(imageData);

      addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles, addGalleryImage, referenceEnabled, hasSource]
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (referenceEnabled && hasSource) setIsDragOver(true);
    },
    [referenceEnabled, hasSource]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (referenceEnabled && hasSource) setIsDragOver(true);
    },
    [referenceEnabled, hasSource]
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      addFiles(Array.from(e.target.files || []));
      e.target.value = "";
    },
    [addFiles]
  );

  // `canSubmit` alone doesn't stop a second Enter while the canvas blob loads: the
  // instruction is only cleared after the await, so guard the load explicitly.
  const isPreparingSubmitRef = useRef(false);
  const handleSubmit = useCallback(async () => {
    if (!canSubmit || isPreparingSubmitRef.current) return;

    isPreparingSubmitRef.current = true;
    let canvasBlob: Blob | null;
    try {
      canvasBlob = await getCanvasBlob().catch(() => null);
    } finally {
      isPreparingSubmitRef.current = false;
    }
    if (!canvasBlob) return;

    setIsGenerating(true);
    const text = instruction.trim();
    setInstruction("");

    // Prepend context brief from the source turn if enabled
    let finalInstruction = text;
    if (contextInjectionEnabled && !contextBriefDismissed && selectedItemId) {
      const brief = getSourceTurnBrief(turns, selectedItemId);
      if (brief) {
        finalInstruction = `[Context: ${brief}]\n\n${text}`;
      }
    }

    try {
      // Save the canvas blob as a reference image for retry support
      const refId = crypto.randomUUID();
      const canvasSourceGalleryItemId = selectedItemId ?? sourceGalleryItemId ?? undefined;
      await saveReferenceImage({
        id: refId,
        blob: canvasBlob,
        name: "editor-source",
        sourceGalleryItemId: canvasSourceGalleryItemId,
      });

      const turnId = crypto.randomUUID();
      addTurn({
        id: turnId,
        instruction: text,
        sourceItemId: selectedItemId,
        sourceBlob: canvasBlob,
        sourceReferenceId: refId,
        createdAt: Date.now(),
      });

      // Fire-and-forget: generate context brief for this turn in parallel
      if (contextInjectionEnabled && isTextModelAvailable()) {
        const currentTurns = useEditorStore.getState().turns;
        const currentSourcePrompt = useEditorStore.getState().sourcePrompt;
        const thisTurn = currentTurns.find((t) => t.id === turnId);
        if (thisTurn) {
          void generateContextBrief(
            currentTurns,
            thisTurn,
            currentSourcePrompt,
            referenceImages
          ).then((brief) => {
            if (brief) {
              useEditorStore.getState().setTurnContextBrief(turnId, brief);
            }
          });
        }
      }

      const additionalRefs = referenceImages.map((r) => ({
        id: r.id,
        blob: r.blob,
        name: r.name,
        sourceGalleryItemId: r.sourceGalleryItemId,
      }));

      await generateEdit({
        instruction: finalInstruction,
        basePrompt: instructionBasePrompt ?? text,
        referenceBlob: canvasBlob,
        referenceId: refId,
        sourceGalleryItemId: canvasSourceGalleryItemId,
        additionalReferences: additionalRefs.length > 0 ? additionalRefs : undefined,
        modelSelections,
        aspectRatio,
        resolution,
        modelOptions,
        skipAutoImprove: instructionBasePrompt !== null,
        onItemsCreated: (itemIds) => {
          for (const id of itemIds) {
            addItemToTurn(turnId, id);
          }
          // Deselect source while generating
          selectItem(null);
        },
        onPromptPrepared: (sentPrompt) => {
          if (sentPrompt !== text) {
            setTurnSentInstruction(turnId, sentPrompt);
          }
        },
      });
    } finally {
      setIsGenerating(false);
    }
  }, [
    canSubmit,
    getCanvasBlob,
    instruction,
    setInstruction,
    setIsGenerating,
    selectedItemId,
    addTurn,
    addItemToTurn,
    selectItem,
    generateEdit,
    referenceImages,
    modelSelections,
    aspectRatio,
    resolution,
    modelOptions,
    contextInjectionEnabled,
    contextBriefDismissed,
    turns,
    sourcePrompt,
    sourceGalleryItemId,
    setTurnSentInstruction,
  ]);

  const improveInstruction = useImproveText({
    systemPrompt: ELABORATE_PROMPT_SYSTEM,
    text: instruction,
    setText: setInstruction,
    baseText: instructionBasePrompt,
    setBaseText: setInstructionBasePrompt,
    getImages: async () => {
      const canvasBlob = await getCanvasBlob();
      return canvasBlob ? [canvasBlob] : undefined;
    },
  });

  const handleAnalyze = useCallback(async () => {
    if (isAnalyzing) return;
    const canvasBlob = await getCanvasBlob().catch(() => null);
    if (!canvasBlob) return;

    setAnalyzing(true);
    setAnalysisResult(null);
    try {
      const result = await callTextModel(
        REVERSE_PROMPT_SYSTEM,
        "Write a generation prompt for this image.",
        [canvasBlob]
      );
      setAnalysisResult(result.trim());
    } catch {
      // silently fail
    } finally {
      setAnalyzing(false);
    }
  }, [getCanvasBlob, isAnalyzing, setAnalyzing, setAnalysisResult]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const items = e.clipboardData.items;
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file && file.type.startsWith("image/")) {
            e.preventDefault();
            if (!hasSource && onSourceFile) {
              onSourceFile(file);
            } else if (hasSource && canAttachMore) {
              addFiles([file]);
            }
            return;
          }
        }
      }
    },
    [hasSource, onSourceFile, canAttachMore, addFiles]
  );

  const turnCount = turns.length;

  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      document.documentElement.style.setProperty("--editor-input-height", `${el.offsetHeight}px`);
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--editor-input-height");
    };
  }, []);

  return (
    <div ref={barRef} className="absolute right-0 bottom-0 left-0">
      <div className="from-surface via-surface/95 bg-linear-to-t to-transparent px-6 pt-8 pb-4">
        <div className="mx-auto max-w-4xl">
          {/* Textarea */}
          <div
            onDrop={handleDrop}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            className={`bg-surface-overlay/80 rounded-xl border transition-all duration-200 ${
              isDragOver && referenceEnabled && hasSource
                ? "border-purple-500 ring-1 ring-purple-500/50"
                : !hasSource
                  ? "border-c-border/50 opacity-60"
                  : "border-c-border focus-within:border-c-border focus-within:ring-c-border/50 focus-within:ring-1"
            }`}
          >
            {/* Context brief banner */}
            {contextBrief && contextInjectionEnabled && !contextBriefDismissed && (
              <div className="border-c-border/50 flex items-start gap-2 border-b px-4 py-2">
                <Sparkles className="text-accent-muted mt-0.5 h-3 w-3 shrink-0" />
                <p className="text-text-tertiary flex-1 text-xs leading-relaxed">{contextBrief}</p>
                <button
                  type="button"
                  onClick={() => setContextBriefDismissed(true)}
                  className="text-text-muted hover:text-text-tertiary shrink-0 rounded p-0.5 transition-colors"
                  title="Dismiss context brief for this edit"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            )}

            <textarea
              ref={textareaRef}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={
                !hasSource
                  ? "Paste or drop an image to begin editing…"
                  : selectedItemId || turnCount === 0
                    ? "Describe your edit… (Ctrl+Enter to send)"
                    : "Select an image above, then describe your edit…"
              }
              rows={1}
              className="text-text-primary placeholder-text-muted field-sizing-content max-h-48 min-h-11 w-full resize-none rounded-t-xl bg-transparent px-4 pt-3 pb-2 text-sm focus:outline-none disabled:cursor-not-allowed"
            />

            {/* Reference images */}
            {(referenceImages.length > 0 || (isDragOver && hasSource)) && (
              <div className="px-3 py-2">
                <DndContext
                  sensors={refDndSensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleRefDragEnd}
                >
                  <SortableContext
                    items={referenceImages.map((img) => img.id)}
                    strategy={rectSortingStrategy}
                  >
                    <div className="grid max-w-full grid-cols-[repeat(auto-fill,minmax(80px,1fr))] gap-2">
                      {referenceImages.map((img) => (
                        <SortableReferenceImage
                          key={img.id}
                          img={img}
                          onRemove={removeReferenceImage}
                          onOpen={(img) =>
                            openLightbox({
                              kind: "reference",
                              image: { id: img.id, url: img.url, name: img.name },
                            })
                          }
                          onEdit={setEditingReferenceId}
                        />
                      ))}

                      {isDragOver && referenceImages.length === 0 && (
                        <div className="border-c-border text-text-tertiary col-span-full rounded-lg border-2 border-dashed py-8 text-center text-xs">
                          Drop images here
                        </div>
                      )}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>
            )}

            {/* Bottom row of input */}
            <div className="flex items-center justify-between gap-2 px-3 pb-3">
              {/* Left: model chip + analyze + references */}
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                {/* Model chip */}
                <div className="bg-surface-interactive/60 text-text-tertiary flex max-w-40 items-center gap-1.5 truncate rounded-full px-2.5 py-1 text-xs">
                  <Sparkles className="text-accent-muted h-3 w-3 shrink-0" />
                  <span className="truncate">{modelChipLabel}</span>
                </div>

                {/* Analyze button */}
                <Tooltip content="Generate a prompt based on the source image">
                  <button
                    type="button"
                    onClick={() => void handleAnalyze()}
                    disabled={!hasSource || isAnalyzing || isGenerating}
                    className="text-text-muted hover:bg-surface-interactive/60 hover:text-text-secondary flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {isAnalyzing ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <ScanSearch className="h-3 w-3" />
                    )}
                    {isAnalyzing ? "Analyzing…" : "Analyze"}
                  </button>
                </Tooltip>

                {/* Rewrite / Undo button */}
                {improveInstruction.hasUndo ? (
                  <Tooltip content="Restore your original instruction">
                    <button
                      type="button"
                      onClick={improveInstruction.undo}
                      className="text-text-muted hover:bg-surface-interactive/60 hover:text-text-secondary flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors"
                    >
                      <Undo2 className="h-3 w-3" />
                      Undo
                    </button>
                  </Tooltip>
                ) : (
                  <Tooltip content="Use AI to rewrite your instruction">
                    <button
                      type="button"
                      onClick={() => void improveInstruction.improve()}
                      disabled={
                        !isTextModelAvailable() ||
                        !instruction.trim() ||
                        improveInstruction.isImproving
                      }
                      className="text-text-muted hover:bg-surface-interactive/60 hover:text-text-secondary flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {improveInstruction.isImproving ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Sparkles className="h-3 w-3" />
                      )}
                      {improveInstruction.isImproving ? "Working..." : "Rewrite"}
                    </button>
                  </Tooltip>
                )}

                {/* Attach references button */}
                {referenceEnabled && hasSource && (
                  <Tooltip
                    content={
                      canAttachMore
                        ? `${referenceImages.length}/${referenceLimit === Infinity ? "\u221E" : referenceLimit} references attached`
                        : "Reference limit reached"
                    }
                  >
                    <label
                      className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors ${
                        canAttachMore
                          ? "text-text-muted hover:bg-surface-interactive/60 hover:text-text-secondary"
                          : "text-text-muted cursor-not-allowed"
                      }`}
                    >
                      <ImagePlus className="h-3 w-3" />
                      {referenceImages.length > 0 ? ` References` : "References"}
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        onChange={handleFileSelect}
                        disabled={!canAttachMore}
                        className="hidden"
                      />
                    </label>
                  </Tooltip>
                )}
              </div>

              {/* Right: send button */}
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-all duration-150 ${
                  canSubmit
                    ? "-translate-y-0.5 bg-purple-600 text-white shadow-lg shadow-purple-900/40 hover:bg-purple-500 active:translate-y-0"
                    : "bg-surface-interactive/50 text-text-muted cursor-not-allowed"
                }`}
                title="Send edit (Ctrl+Enter)"
              >
                {isGenerating ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowUp className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
      {editingReference && (
        <ReferenceImageMarkupOverlay
          image={editingReference}
          onClose={() => setEditingReferenceId(null)}
          onApply={(nextImage) => replaceReferenceImage(editingReference.id, nextImage)}
        />
      )}
    </div>
  );
}
