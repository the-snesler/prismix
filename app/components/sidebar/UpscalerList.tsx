import { Expand } from "lucide-react";
import { useCallback } from "react";
import { CollapsibleSection } from "./CollapsibleSection";
import { useSettingsStore } from "~/stores/settingsStore";
import { useEditorStore } from "~/stores/editorStore";
import { useGalleryStore } from "~/stores/galleryStore";
import { useEditorGeneration } from "~/hooks/useEditorGeneration";
import { loadImageBlob, saveReferenceImage } from "~/lib/db";
import { getSourceTurnBrief } from "~/lib/contextBrief";
import { logger } from "~/lib/logging";
import type { StoredUpscaler } from "~/types";

interface UpscalerListProps {
  /** When true, briefly highlight the section to draw attention. */
  highlight?: boolean;
}

export function UpscalerList({ highlight = false }: UpscalerListProps) {
  const upscalers = useSettingsStore((s) => s.upscalers);
  const replicateKey = useSettingsStore((s) => s.apiKeys.replicate);
  const isGenerating = useEditorStore((s) => s.isGenerating);
  const hasSource = useEditorStore((s) => s.sourceBlob !== null);
  const addTurn = useEditorStore((s) => s.addTurn);
  const addItemToTurn = useEditorStore((s) => s.addItemToTurn);
  const selectItem = useEditorStore((s) => s.selectItem);
  const setIsGenerating = useEditorStore((s) => s.setIsGenerating);
  const { generateUpscale } = useEditorGeneration();

  const visibleUpscalers = replicateKey ? upscalers.filter((u) => u.enabled) : [];

  const handleClick = useCallback(
    async (upscaler: StoredUpscaler) => {
      if (isGenerating || !replicateKey) return;
      const editor = useEditorStore.getState();

      // Resolve the canvas: selected turn item, otherwise the original source.
      let canvasBlob: Blob | null = null;
      let canvasSourceGalleryItemId: string | undefined;
      if (editor.selectedItemId) {
        const item = useGalleryStore.getState().items.find((i) => i.id === editor.selectedItemId);
        if (item && item.status === "completed") {
          try {
            canvasBlob = await loadImageBlob(item);
          } catch (error) {
            logger.error("[upscaler] Failed to load selected image", error);
            return;
          }
          canvasSourceGalleryItemId = item.id;
        }
      }
      if (!canvasBlob) {
        canvasBlob = editor.sourceBlob;
        canvasSourceGalleryItemId = editor.sourceGalleryItemId ?? undefined;
      }
      if (!canvasBlob) return;

      // Inherit the parent turn's contextBrief — same image lineage, no need to regenerate.
      const parentBrief = getSourceTurnBrief(editor.turns, editor.selectedItemId);

      setIsGenerating(true);
      try {
        const refId = crypto.randomUUID();
        await saveReferenceImage({
          id: refId,
          blob: canvasBlob,
          name: "upscale-source",
          sourceGalleryItemId: canvasSourceGalleryItemId,
        });

        const turnId = crypto.randomUUID();
        addTurn({
          id: turnId,
          instruction: `Upscale with ${upscaler.name}`,
          sourceItemId: editor.selectedItemId,
          sourceBlob: canvasBlob,
          sourceReferenceId: refId,
          createdAt: Date.now(),
          contextBrief: parentBrief ?? undefined,
        });

        await generateUpscale({
          referenceBlob: canvasBlob,
          referenceId: refId,
          sourceGalleryItemId: canvasSourceGalleryItemId,
          upscaler,
          onItemsCreated: (itemIds) => {
            for (const id of itemIds) addItemToTurn(turnId, id);
            selectItem(null);
          },
        });
      } finally {
        setIsGenerating(false);
      }
    },
    [
      addItemToTurn,
      addTurn,
      generateUpscale,
      isGenerating,
      replicateKey,
      selectItem,
      setIsGenerating,
    ]
  );

  const buttonsDisabled = isGenerating || !hasSource;

  return (
    <CollapsibleSection
      value="upscalers"
      icon={<Expand className="h-4 w-4" />}
      title="Upscale Models"
      tooltip="Click an upscaler to immediately upscale the currently selected image as a new turn."
    >
      {visibleUpscalers.length === 0 ? (
        <p className="text-text-muted py-4 text-center text-xs">
          {replicateKey
            ? "No upscalers enabled. Enable or add one in Settings."
            : "Add a Replicate API key to use upscalers."}
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {visibleUpscalers.map((u) => (
            <button
              key={u.id}
              type="button"
              disabled={buttonsDisabled}
              onClick={() => void handleClick(u)}
              className="bg-surface-overlay/50 text-text-secondary hover:bg-surface-overlay disabled:bg-surface-overlay/30 disabled:text-text-muted truncate rounded-lg border border-transparent px-3 py-2 text-xs transition-colors disabled:cursor-not-allowed"
              title={u.name}
            >
              {u.name}
            </button>
          ))}
        </div>
      )}
    </CollapsibleSection>
  );
}
