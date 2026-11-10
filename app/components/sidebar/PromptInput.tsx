import { ImagePlus, Wand2 } from "lucide-react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
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
import { useImproveText } from "~/hooks/useImproveText";
import { loadImageBlob } from "~/lib/db";
import { logger } from "~/lib/logging";
import { anyModelSupportsReferenceImages, isSoleArbitraryAspectRatioModel } from "~/lib/models";
import { ELABORATE_PROMPT_SYSTEM } from "~/lib/prompts";
import { buildElaborationContext } from "~/lib/promptUnification";
import { isTextModelAvailable } from "~/lib/textModel";
import { useGalleryStore } from "~/stores/galleryStore";
import { useGenerationStore } from "~/stores/generationStore";
import { useLightboxStore } from "~/stores/lightboxStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { ImproveTextButton } from "../ui/ImproveTextButton";
import { StyleSelect } from "./StyleSelect";
import { CharacterSelect } from "./CharacterSelect";
import { ReferenceImageMarkupOverlay } from "../reference/ReferenceImageMarkupOverlay";
import { SortableReferenceImage } from "../reference/SortableReferenceImage";

export function PromptInput() {
  const prompt = useGenerationStore((s) => s.currentPrompt);
  const setPrompt = useGenerationStore((s) => s.setPrompt);
  const setAspectRatio = useGenerationStore((s) => s.setAspectRatio);
  const basePrompt = useGenerationStore((s) => s.currentBasePrompt);
  const setBasePrompt = useGenerationStore((s) => s.setBasePrompt);
  const referenceImages = useGenerationStore((s) => s.currentReferenceImages);
  const addReferenceImage = useGenerationStore((s) => s.addReferenceImage);
  const removeReferenceImage = useGenerationStore((s) => s.removeReferenceImage);
  const replaceReferenceImage = useGenerationStore((s) => s.replaceReferenceImage);
  const reorderReferenceImages = useGenerationStore((s) => s.reorderReferenceImages);
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
  const currentStyleId = useGenerationStore((s) => s.currentStyleId);
  const currentCharacterIds = useGenerationStore((s) => s.currentCharacterIds);
  const galleryItems = useGalleryStore((s) => s.items);
  const models = useSettingsStore((s) => s.models);
  const styles = useSettingsStore((s) => s.styles);
  const characters = useSettingsStore((s) => s.characters);
  const [isDragOver, setIsDragOver] = useState(false);
  const [editingReferenceId, setEditingReferenceId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const selectedStyle = useMemo(
    () =>
      currentStyleId ? (styles.find((s) => s.id === currentStyleId && s.enabled) ?? null) : null,
    [currentStyleId, styles]
  );
  const selectedCharacters = useMemo(
    () =>
      currentCharacterIds
        .map((id) => characters.find((c) => c.id === id && c.enabled))
        .filter((c): c is NonNullable<typeof c> => c !== undefined),
    [currentCharacterIds, characters]
  );

  const improvePrompt = useImproveText({
    systemPrompt: ELABORATE_PROMPT_SYSTEM,
    text: prompt,
    setText: setPrompt,
    baseText: basePrompt,
    setBaseText: setBasePrompt,
    getImages: () => (referenceImages.length > 0 ? referenceImages.map((r) => r.blob) : undefined),
    buildUserPrompt: (text) =>
      buildElaborationContext({
        prompt: text,
        characters: selectedCharacters,
        style: selectedStyle,
      }),
  });

  const supportsFieldSizing = useMemo(() => {
    if (typeof CSS === "undefined" || typeof CSS.supports !== "function") {
      return false;
    }

    return CSS.supports("field-sizing", "content");
  }, []);

  const selectedModels = useMemo(
    () =>
      Object.entries(modelSelections)
        .filter(([, count]) => count > 0)
        .map(([modelId]) => modelId),
    [modelSelections]
  );

  const referenceEnabled = anyModelSupportsReferenceImages(models, selectedModels);
  const arbitraryAspectRatioModel = isSoleArbitraryAspectRatioModel(models, selectedModels)
    ? models.find((model) => model.id === selectedModels[0])
    : undefined;
  const isExpanded = isDragOver || referenceImages.length > 0;
  const editingReference = editingReferenceId
    ? (referenceImages.find((img) => img.id === editingReferenceId) ?? null)
    : null;

  const addFiles = useCallback(
    (files: File[]) => {
      if (!referenceEnabled) return;

      const imageFiles = files.filter((file) => file.type.startsWith("image/"));
      for (const file of imageFiles) {
        const url = URL.createObjectURL(file);
        addReferenceImage({
          id: crypto.randomUUID(),
          blob: file,
          url,
          name: file.name,
        });
      }
    },
    [addReferenceImage, referenceEnabled]
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

        if (imageId) {
          const galleryItem = galleryItems.find((item) => item.id === imageId);
          if (galleryItem && galleryItem.status === "completed") {
            loadImageBlob(galleryItem)
              .then((imageBlob) => {
                addReferenceImage({
                  id: crypto.randomUUID(),
                  blob: imageBlob,
                  url: URL.createObjectURL(imageBlob),
                  name: name || "Gallery image",
                  sourceGalleryItemId: imageId,
                });
              })
              .catch((error) => {
                logger.error("[prompt-input] Failed to load dropped gallery image", error);
              });
            return;
          }
        }

        if (typeof blob === "string") {
          fetch(blob)
            .then((res) => res.blob())
            .then((blobData) => {
              const objectUrl = URL.createObjectURL(blobData);
              addReferenceImage({
                id: crypto.randomUUID(),
                blob: blobData,
                url: objectUrl,
                name: name || "Gallery image",
              });
            });
        }
      } catch {
        // Ignore invalid drag payloads.
      }
    },
    [addReferenceImage, referenceEnabled, galleryItems]
  );

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!referenceEnabled) return;

    const items = e.clipboardData.items;
    for (const item of items) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && file.type.startsWith("image/")) {
          addFiles([file]);
        }
      }
    }
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);

      if (!referenceEnabled) return;

      const imageData = e.dataTransfer.getData("application/json");
      if (imageData) {
        addGalleryImage(imageData);
      }

      addFiles(Array.from(e.dataTransfer.files));
    },
    [addFiles, addGalleryImage, referenceEnabled]
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (referenceEnabled) {
        setIsDragOver(true);
      }
    },
    [referenceEnabled]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (referenceEnabled) {
        setIsDragOver(true);
      }
    },
    [referenceEnabled]
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

  useLayoutEffect(() => {
    if (supportsFieldSizing) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "0px";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [prompt, supportsFieldSizing]);

  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        <Wand2 className="text-text-muted h-4 w-4" />
        <h2 className="text-text-tertiary text-xs font-medium tracking-wide uppercase">Prompt</h2>
      </div>

      <div
        onDrop={handleDrop}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`bg-surface-overlay rounded-lg border transition-colors ${
          isDragOver && referenceEnabled
            ? "border-purple-500 ring-1 ring-purple-500"
            : "border-c-border"
        }`}
      >
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={handlePaste}
          placeholder="Describe your image..."
          className="text-text-primary placeholder-text-muted field-sizing-content max-h-1/2 min-h-24 w-full resize-none rounded-t-lg bg-transparent px-3 pt-2 pb-2 text-sm focus:outline-none"
        />

        <div className="items-left mx-3 flex justify-between gap-3">
          <ImproveTextButton
            isImproving={improvePrompt.isImproving}
            hasUndo={improvePrompt.hasUndo}
            onImprove={improvePrompt.improve}
            onUndo={improvePrompt.undo}
            canImprove={isTextModelAvailable() && prompt.trim().length > 0}
          />
        </div>

        <div className="border-c-border/50 my-3 border-t" />

        {isExpanded && (
          <div className="px-3">
            <DndContext
              sensors={refDndSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleRefDragEnd}
              autoScroll={false}
            >
              <SortableContext
                items={referenceImages.map((img) => img.id)}
                strategy={rectSortingStrategy}
              >
                <div className="grid max-w-full grid-cols-3 gap-2">
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
                      onMatchAspectRatio={arbitraryAspectRatioModel ? setAspectRatio : undefined}
                      maxLongShortRatio={arbitraryAspectRatioModel?.capabilities.maxLongShortRatio}
                      referenceEnabled={referenceEnabled}
                    />
                  ))}

                  {isDragOver && referenceImages.length === 0 && (
                    <div className="border-c-border text-text-tertiary col-span-3 rounded-lg border-2 border-dashed py-4 text-center text-xs">
                      Drop images here
                    </div>
                  )}
                </div>
              </SortableContext>
            </DndContext>
          </div>
        )}

        <div className="mx-3 my-3 flex items-center justify-between gap-3">
          <label
            className={`inline-flex shrink-0 items-center gap-1 text-xs transition-colors ${
              referenceEnabled
                ? "text-text-tertiary hover:text-text-secondary"
                : "text-text-muted cursor-not-allowed"
            }`}
          >
            <ImagePlus className="h-4 w-4" />
            Attach
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={handleFileSelect}
              disabled={!referenceEnabled}
              className="hidden"
            />
          </label>

          <CharacterSelect />
          <StyleSelect />
        </div>
      </div>
      {editingReference && (
        <ReferenceImageMarkupOverlay
          image={editingReference}
          onClose={() => setEditingReferenceId(null)}
          onApply={(nextImage) => replaceReferenceImage(editingReference.id, nextImage)}
        />
      )}
    </section>
  );
}
