import { Check, Layers2, Link2, Maximize2, Square } from "lucide-react";
import { LoadingCard } from "~/components/gallery/LoadingCard";
import { useEffect, useMemo, useRef, useState } from "react";
import { useGalleryStore } from "~/stores/galleryStore";
import { useEditorStore } from "~/stores/editorStore";
import { useLightboxStore } from "~/stores/lightboxStore";
import { useDiffStore } from "~/stores/diffStore";
import type { EditorTurn } from "~/types";
import { SineWaveGrid } from "~/components/gallery/SineWaveGrid";
import { useGalleryDerivedIndexes } from "~/hooks/useGalleryDerivedIndexes";
import { aspectRatiosCompatibleForDiff } from "~/lib/models";

interface TurnProps {
  turn: EditorTurn;
  turnIndex: number;
  isFirst?: boolean;
}

export function Turn({ turn, turnIndex, isFirst = false }: TurnProps) {
  const { getItemById } = useGalleryDerivedIndexes();
  const items = useMemo(
    () => turn.itemIds.map((id) => getItemById(id)).filter(Boolean),
    [getItemById, turn.itemIds]
  ) as ReturnType<typeof useGalleryStore.getState>["items"];

  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const selectItem = useEditorStore((s) => s.selectItem);
  const turns = useEditorStore((s) => s.turns);
  const isGeneratingEdit = useEditorStore((s) => s.isGenerating);

  // Source thumbnail URL: comes from the item used as reference, or source blob
  const [sourceThumbUrl, setSourceThumbUrl] = useState<string | null>(null);

  useEffect(() => {
    if (turn.sourceItemId) {
      const item = getItemById(turn.sourceItemId);
      if (item && item.status === "completed") {
        setSourceThumbUrl(item.thumbnailUrl);
      }
    } else {
      // Use source blob
      if (turn.sourceBlob) {
        const url = URL.createObjectURL(turn.sourceBlob);
        setSourceThumbUrl(url);
        return () => URL.revokeObjectURL(url);
      }
    }
  }, [getItemById, turn.sourceItemId, turn.sourceBlob]);

  // Object URL for an uploaded source (no gallery item), owned by this turn. It backs
  // the diff viewer's parent image, so it must outlive any diff opened from here.
  const [uploadedSourceUrl, setUploadedSourceUrl] = useState<string | null>(null);
  useEffect(() => {
    if (turn.sourceItemId || !turn.sourceBlob) {
      setUploadedSourceUrl(null);
      return;
    }
    const url = URL.createObjectURL(turn.sourceBlob);
    setUploadedSourceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [turn.sourceItemId, turn.sourceBlob]);

  // Parent image (for diff viewer): either the source gallery item's full-res image,
  // or the original uploaded source if this turn edits the original.
  const { parentUrl, parentLabel, parentItemAspect } = useMemo(() => {
    if (turn.sourceItemId) {
      const item = getItemById(turn.sourceItemId);
      if (item && item.status === "completed") {
        const aspect = item.width > 0 && item.height > 0 ? item.width / item.height : null;
        return {
          parentUrl: item.originalUrl,
          parentLabel: item.modelName,
          parentItemAspect: aspect,
        };
      }
      return { parentUrl: null, parentLabel: undefined, parentItemAspect: null };
    }
    return { parentUrl: uploadedSourceUrl, parentLabel: "Source", parentItemAspect: null };
  }, [getItemById, turn.sourceItemId, uploadedSourceUrl]);

  // When the parent is an uploaded blob (no gallery item), read its natural dimensions
  // once so we can compare aspect ratios against child outputs.
  const [parentBlobAspect, setParentBlobAspect] = useState<number | null>(null);
  useEffect(() => {
    if (parentItemAspect != null || !parentUrl) {
      setParentBlobAspect(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setParentBlobAspect(img.naturalWidth / img.naturalHeight);
      }
    };
    img.src = parentUrl;
    return () => {
      cancelled = true;
    };
  }, [parentUrl, parentItemAspect]);

  const parentAspect = parentItemAspect ?? parentBlobAspect;

  // Auto-select the first completed item in the most recent turn (once only)
  const isLastTurn = turnIndex === turns.length - 1;
  const hasAutoSelectedRef = useRef(false);
  useEffect(() => {
    if (!isLastTurn) return;
    if (hasAutoSelectedRef.current) return;
    const firstCompleted = items.find((item) => item?.status === "completed");
    if (firstCompleted && !selectedItemId) {
      selectItem(firstCompleted.id);
      hasAutoSelectedRef.current = true;
    }
  }, [items, isLastTurn, selectedItemId, selectItem]);

  // Show a placeholder skeleton for the latest turn while an edit is in flight
  // but before the prompt-prep pipeline has created pending items.
  const isPendingFirstItems =
    items.filter(Boolean).length === 0 &&
    turn.itemIds.length === 0 &&
    isLastTurn &&
    isGeneratingEdit;

  if (items.filter(Boolean).length === 0 && !isPendingFirstItems) return null;

  const showSentInstruction = turn.sentInstruction && turn.sentInstruction !== turn.instruction;

  return (
    <div className="animate-fade-in flex w-full flex-col items-center">
      {/* Turn header */}
      <div className="mb-1 flex w-full max-w-4xl items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="text-text-secondary text-sm leading-snug font-medium">{turn.instruction}</p>
          {showSentInstruction && (
            <details className="group/sent">
              <summary className="text-text-muted hover:text-text-tertiary list-none text-xs [&::-webkit-details-marker]:hidden">
                Show sent prompt
              </summary>
              <p className="bg-surface-overlay/50 text-text-tertiary mt-1 rounded p-2 text-xs leading-snug whitespace-pre-wrap">
                {turn.sentInstruction}
              </p>
            </details>
          )}
        </div>

        {/* Source thumbnail */}
        {sourceThumbUrl && (
          <div className="flex shrink-0 items-center gap-1.5">
            <Link2 className="text-text-muted h-3 w-3" />
            <div className="border-c-border bg-surface-overlay h-8 w-8 overflow-hidden rounded-md border">
              <img src={sourceThumbUrl} alt="source" className="h-full w-full object-cover" />
            </div>
          </div>
        )}
      </div>

      {/* Image grid */}
      <div className="grid w-full max-w-4xl grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3 p-3">
        {isPendingFirstItems ? (
          <EditorPendingSkeleton />
        ) : (
          items.map((item) => {
            if (!item) return null;

            if (item.status === "completed") {
              const isSelected = selectedItemId === item.id;
              return (
                <EditorImageCard
                  key={item.id}
                  itemId={item.id}
                  thumbnailUrl={item.thumbnailUrl}
                  modelName={item.modelName}
                  isSelected={isSelected}
                  onClick={() => selectItem(item.id)}
                  childUrl={item.originalUrl}
                  childAspect={item.width > 0 && item.height > 0 ? item.width / item.height : null}
                  parentUrl={parentUrl}
                  parentLabel={parentLabel}
                  parentAspect={parentAspect}
                />
              );
            }

            return <LoadingCard key={item.id} item={item} variant="editor" />;
          })
        )}
      </div>
    </div>
  );
}

function EditorPendingSkeleton() {
  return (
    <div
      className="bg-surface-raised ring-border-subtle relative overflow-hidden rounded-lg ring-1"
      style={{ aspectRatio: "1/1" }}
    >
      <SineWaveGrid />
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <p className="text-xs font-medium text-white/80 drop-shadow-lg">Generating...</p>
      </div>
    </div>
  );
}

function EditorImageCard({
  thumbnailUrl,
  modelName,
  isSelected,
  onClick,
  itemId,
  childUrl,
  childAspect,
  parentUrl,
  parentLabel,
  parentAspect,
}: {
  thumbnailUrl: string;
  modelName: string;
  isSelected: boolean;
  onClick: () => void;
  itemId: string;
  childUrl: string;
  childAspect: number | null;
  parentUrl: string | null;
  parentLabel?: string;
  parentAspect: number | null;
}) {
  const canDiff =
    parentUrl != null &&
    parentAspect != null &&
    childAspect != null &&
    aspectRatiosCompatibleForDiff(parentAspect, childAspect);
  const [isLoaded, setIsLoaded] = useState(false);
  const openLightbox = useLightboxStore((s) => s.openLightbox);
  const openDiff = useDiffStore((s) => s.openDiff);

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group bg-surface-overlay relative overflow-hidden rounded-lg transition-all duration-150 ${
        isSelected
          ? "ring-offset-surface ring-2 ring-purple-500 ring-offset-2"
          : "ring-c-border/50 hover:ring-c-border ring-1"
      }`}
    >
      <img
        src={thumbnailUrl}
        alt={modelName}
        className={`h-auto w-full transition-opacity duration-300 ${isLoaded ? "opacity-100" : "opacity-0"}`}
        onLoad={() => setIsLoaded(true)}
      />
      {!isLoaded && (
        <div
          className="bg-surface-overlay absolute inset-0 animate-pulse"
          style={{ aspectRatio: "1/1" }}
        />
      )}

      {/* Model badge */}
      <div className="absolute bottom-2 left-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white/80 backdrop-blur-sm">
        {modelName}
      </div>

      {/* Toolbar */}
      <div className="absolute top-2 left-2 z-10 flex items-center gap-1.5">
        {/* Selection indicator (always visible) */}
        <div
          className={`flex h-7 w-7 items-center justify-center rounded-md backdrop-blur-sm ${
            isSelected ? "bg-purple-500" : "bg-black/60"
          }`}
        >
          {isSelected ? (
            <Check className="h-4 w-4 text-white" />
          ) : (
            <Square className="h-4 w-4 text-white/80" />
          )}
        </div>

        {/* Maximize button (hover only) */}
        <div
          className="opacity-0 transition-opacity duration-150 group-hover:opacity-100"
          onClick={(e) => {
            e.stopPropagation();
            openLightbox({ kind: "gallery", imageId: itemId });
          }}
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 backdrop-blur-sm">
            <Maximize2 className="h-4 w-4 text-white/80" />
          </div>
        </div>

        {/* Diff button (hover only) */}
        {canDiff && parentUrl && (
          <div
            className="opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              openDiff({
                parentUrl,
                childUrl,
                parentLabel,
                childLabel: modelName,
              });
            }}
            title="Compare with source"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-black/60 backdrop-blur-sm">
              <Layers2 className="h-4 w-4 text-white/80" />
            </div>
          </div>
        )}
      </div>

      {/* Hover overlay hint when not selected */}
      {!isSelected && (
        <div className="absolute inset-0 bg-white/0 transition-colors group-hover:bg-white/5" />
      )}
    </button>
  );
}
