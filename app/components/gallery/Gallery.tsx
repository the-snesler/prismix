import { useState, useEffect, useRef, useMemo } from "react";
import { useGalleryStore } from "~/stores/galleryStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { GalleryHeader } from "./GalleryHeader";
import { MasonryGrid, MasonryFrame } from "./MasonryGrid";
import { GalleryImageCard } from "./GalleryImageCard";
import { TimelineDivider } from "./TimelineDivider";
import { ImageOff, Download, Loader2, Trash2, X, ImagePlus, Star } from "lucide-react";
import type { GalleryItem } from "~/types";
import { formatRelativeDate } from "~/lib/util";
import { getFirstCreatedAt, groupItemsByPrompt } from "~/lib/galleryGrouping";
import { stripVariationSections } from "~/lib/promptVariations";
import { cosine } from "~/lib/embeddingMath";
import NumberFlow from "@number-flow/react";
import { useAttachSelectedItemsToGeneration } from "~/hooks/useAttachSelectedItemsToGeneration";
import { useGalleryDerivedIndexes } from "~/hooks/useGalleryDerivedIndexes";
import { useQueryEmbedding } from "~/hooks/useQueryEmbedding";
import { logger } from "~/lib/logging";
import { importFromZip } from "~/lib/exportImport";

const SEMANTIC_THRESHOLD = 0.1;
const DEMO_BACKUP_URL = import.meta.env.VITE_DEMO_BACKUP_URL as string | undefined;

export function Gallery({ viewMode }: { viewMode: "grid" | "timeline" }) {
  const items = useGalleryStore((s) => s.items);
  const isLoading = useGalleryStore((s) => s.isLoading);
  const selectedCount = useGalleryStore((s) => s.selectedItemIds.length);
  const hasMore = useGalleryStore((s) => s.hasMore);
  const isLoadingMore = useGalleryStore((s) => s.isLoadingMore);
  const loadMoreImages = useGalleryStore((s) => s.loadMoreImages);
  const totalCount = useGalleryStore((s) => s.totalCount);
  const searchQuery = useGalleryStore((s) => s.searchQuery);
  const setSearchQuery = useGalleryStore((s) => s.setSearchQuery);
  const showFavoritesOnly = useGalleryStore((s) => s.showFavoritesOnly);
  const toggleFavoritesFilter = useGalleryStore((s) => s.toggleFavoritesFilter);
  const characterFilter = useGalleryStore((s) => s.characterFilter);
  const setCharacterFilter = useGalleryStore((s) => s.setCharacterFilter);
  const semanticSearchEnabled = useSettingsStore((s) => s.semanticSearchEnabled);
  const { itemsByPrompt } = useGalleryDerivedIndexes();

  const queryEmbedding = useQueryEmbedding(searchQuery, semanticSearchEnabled);

  const filteredItems = useMemo(() => {
    let sourceItems = showFavoritesOnly
      ? items.filter((item) => item.status === "completed" && item.isFavorite)
      : items;

    if (characterFilter) {
      sourceItems = sourceItems.filter((item) => item.characterIds?.includes(characterFilter));
    }

    if (!searchQuery.trim()) return sourceItems;
    const q = searchQuery.trim().toLowerCase();
    const substringMatches = sourceItems.filter(
      (item) =>
        item.prompt.toLowerCase().includes(q) ||
        (item.basePrompt?.toLowerCase().includes(q) ?? false) ||
        item.modelName.toLowerCase().includes(q)
    );

    logger.debug("Substring search results", {
      query: searchQuery,
      count: substringMatches.length,
    });

    if (!semanticSearchEnabled || !queryEmbedding) return substringMatches;

    const substringIds = new Set(substringMatches.map((i) => i.id));
    const semanticMatches: GalleryItem[] = [];
    const scored: Array<{ item: GalleryItem; score: number }> = [];
    for (const item of sourceItems) {
      if (item.status !== "completed") continue;
      if (!item.embedding || item.embedding.length === 0) continue;
      const score = cosine(queryEmbedding, item.embedding);
      if (score >= SEMANTIC_THRESHOLD) scored.push({ item, score });
      if (substringIds.has(item.id) && score < SEMANTIC_THRESHOLD) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score);
    for (const { item } of scored) semanticMatches.push(item);

    logger.debug("Merged search results", {
      query: searchQuery,
      count: semanticMatches.length,
    });

    return semanticMatches;
  }, [
    items,
    searchQuery,
    showFavoritesOnly,
    characterFilter,
    semanticSearchEnabled,
    queryEmbedding,
  ]);

  const isFiltered = Boolean(searchQuery.trim() || showFavoritesOnly || characterFilter);
  const filteredItemsByPrompt = useMemo(
    () => (isFiltered ? groupItemsByPrompt(filteredItems) : itemsByPrompt),
    [filteredItems, itemsByPrompt, isFiltered]
  );

  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMoreImages();
      },
      { rootMargin: "200px", scrollMargin: "400px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasMore, loadMoreImages]);

  if (isLoading) {
    return (
      <main className="flex flex-1 items-center justify-center">
        <div className="text-text-muted">Loading images...</div>
      </main>
    );
  }

  return (
    <main className="bg-surface relative flex h-full flex-1 flex-col overflow-hidden">
      <GalleryHeader
        count={isFiltered ? filteredItems.length : totalCount}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        showFavoritesOnly={showFavoritesOnly}
        onToggleFavorites={toggleFavoritesFilter}
        characterFilter={characterFilter}
        onCharacterFilterChange={setCharacterFilter}
      />

      <div
        data-gallery-view
        className={`flex-1 overflow-y-auto p-2 md:py-4 md:pr-6 md:pl-88 ${selectedCount > 0 ? "pb-28" : ""}`}
      >
        {filteredItems.length === 0 ? (
          isFiltered ? (
            <NoSearchResults
              showFavoritesOnly={showFavoritesOnly}
              hasCharacterFilter={Boolean(characterFilter)}
            />
          ) : (
            <EmptyState />
          )
        ) : viewMode === "grid" ? (
          <GridView items={filteredItems} />
        ) : (
          <TimelineView itemsByPrompt={filteredItemsByPrompt} />
        )}

        <div ref={sentinelRef} className="h-1" />
        {isLoadingMore && (
          <div className="text-text-muted flex justify-center py-6 text-xs">Loading more...</div>
        )}
      </div>

      <SelectionActionPopup />
    </main>
  );
}

function SelectionActionPopup() {
  const selectedCount = useGalleryStore((s) => s.selectedItemIds.length);
  const selectedItemIds = useGalleryStore((s) => s.selectedItemIds);
  const items = useGalleryStore((s) => s.items);
  const clearSelection = useGalleryStore((s) => s.clearSelection);
  const deleteSelectedItems = useGalleryStore((s) => s.deleteSelectedItems);
  const downloadSelectedItems = useGalleryStore((s) => s.downloadSelectedItems);
  const setSelectedItemsFavorite = useGalleryStore((s) => s.setSelectedItemsFavorite);
  const attachSelectedItemsToGeneration = useAttachSelectedItemsToGeneration();
  const [isDeleting, setIsDeleting] = useState(false);
  const selectedSet = useMemo(() => new Set(selectedItemIds), [selectedItemIds]);
  const selectedItems = useMemo(
    () => items.filter((item) => item.status === "completed" && selectedSet.has(item.id)),
    [items, selectedSet]
  );
  const shouldFavoriteSelected = selectedItems.some((item) => !item.isFavorite);

  if (selectedCount === 0) {
    return null;
  }

  const handleAttachSelected = async () => {
    const result = await attachSelectedItemsToGeneration();
    if (!result.success && result.reason) {
      alert(result.reason);
    }
  };

  const handleDeleteSelected = async () => {
    if (isDeleting) return;
    if (!confirm(`Delete ${selectedCount} selected image${selectedCount === 1 ? "" : "s"}?`)) {
      return;
    }

    setIsDeleting(true);
    try {
      await deleteSelectedItems();
    } finally {
      setIsDeleting(false);
    }
  };

  const handleFavoriteSelected = () => {
    void setSelectedItemsFavorite(shouldFavoriteSelected);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-6">
      <div className="animate-slide-up border-c-border bg-surface-raised/95 pointer-events-auto flex items-center gap-2 rounded-xl border px-3 py-2 shadow-lg backdrop-blur-sm">
        <span className="text-text-secondary mr-1 text-xs font-medium">
          <NumberFlow value={selectedCount} className="text-text-secondary text-xs font-medium" />{" "}
          selected
        </span>

        <PopupActionButton
          icon={<X className="h-3.5 w-3.5" />}
          label="Deselect all"
          onClick={clearSelection}
        />

        <PopupActionButton
          icon={<ImagePlus className="h-3.5 w-3.5" />}
          label="Attach to prompt"
          onClick={handleAttachSelected}
        />
        <PopupActionButton
          icon={<Star className={`h-3.5 w-3.5 ${shouldFavoriteSelected ? "" : "fill-current"}`} />}
          label={shouldFavoriteSelected ? "Favorite" : "Unfavorite"}
          onClick={handleFavoriteSelected}
        />
        <PopupActionButton
          icon={<Download className="h-3.5 w-3.5" />}
          label="Download"
          onClick={downloadSelectedItems}
        />
        <PopupActionButton
          icon={<Trash2 className="h-3.5 w-3.5" />}
          label={isDeleting ? "Deleting..." : "Delete"}
          onClick={() => {
            void handleDeleteSelected();
          }}
          variant="danger"
        />
      </div>
    </div>
  );
}

function PopupActionButton({
  icon,
  label,
  onClick,
  variant = "default",
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  variant?: "default" | "danger";
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
        variant === "danger"
          ? "text-red-300 hover:bg-red-500/10"
          : "text-text-secondary hover:bg-surface-overlay"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function NoSearchResults({
  showFavoritesOnly,
  hasCharacterFilter,
}: {
  showFavoritesOnly?: boolean;
  hasCharacterFilter?: boolean;
}) {
  const icon = showFavoritesOnly ? (
    <Star className="text-text-muted h-8 w-8" />
  ) : (
    <ImageOff className="text-text-muted h-8 w-8" />
  );

  const heading = showFavoritesOnly ? "No favorites" : "No results";

  let description = "No images match your search. Try a different prompt or model name.";
  if (showFavoritesOnly) {
    description = "Star images in the gallery or lightbox to collect them here.";
  } else if (hasCharacterFilter) {
    description =
      "No images match this character filter. Try a different character or clear the filter.";
  }

  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="bg-surface-raised mb-4 flex h-16 w-16 items-center justify-center rounded-full">
        {icon}
      </div>
      <h3 className="text-text-secondary mb-2 text-lg font-medium">{heading}</h3>
      <p className="text-text-muted max-w-xs text-sm">{description}</p>
    </div>
  );
}

function EmptyState() {
  const loadImages = useGalleryStore((s) => s.loadImages);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLoadDemo = async () => {
    if (!DEMO_BACKUP_URL) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(DEMO_BACKUP_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const file = new File([blob], "demo.zip", { type: "application/zip" });
      const result = await importFromZip(file);
      if (result.imported > 0) await loadImages();
    } catch (e) {
      setError(`Failed to load demo: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center text-center">
      <div className="bg-surface-raised mb-4 flex h-16 w-16 items-center justify-center rounded-full">
        <ImageOff className="text-text-muted h-8 w-8" />
      </div>
      <h3 className="text-text-secondary mb-2 text-lg font-medium">No images yet</h3>
      <p className="text-text-muted max-w-xs text-sm">
        Enter a prompt, select a model, and click Generate to create your first image.
      </p>
      {DEMO_BACKUP_URL && (
        <>
          <button
            type="button"
            onClick={handleLoadDemo}
            disabled={loading}
            className="bg-surface-overlay text-text-secondary hover:bg-surface-interactive mt-4 flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="h-3.5 w-3.5" />
            )}
            {loading ? "Loading demo..." : "Load demo gallery"}
          </button>
          {error && <p className="mt-2 max-w-xs text-xs text-red-400">{error}</p>}
        </>
      )}
    </div>
  );
}

function getFrameDimensions(item: GalleryItem): { width: number; height: number } {
  if (item.status === "completed") {
    return { width: item.width, height: item.height };
  }
  if (item.aspectRatio) {
    const [w, h] = item.aspectRatio.split(":").map(Number);
    if (w && h) return { width: w, height: h };
  }
  if (item.loadingPreview) {
    return { width: item.loadingPreview.width, height: item.loadingPreview.height };
  }
  return { width: 1, height: 1 };
}

function GridView({ items }: { items: ReturnType<typeof useGalleryStore.getState>["items"] }) {
  return (
    <MasonryGrid>
      {items.map((item) => {
        const { width, height } = getFrameDimensions(item);
        return (
          <MasonryFrame key={item.id} width={width} height={height}>
            <GalleryImageCard item={item} />
          </MasonryFrame>
        );
      })}
    </MasonryGrid>
  );
}

function TimelineView({ itemsByPrompt }: { itemsByPrompt: Map<string, GalleryItem[]> }) {
  const entries = Array.from(itemsByPrompt.entries());

  return (
    <div>
      {entries.map(([promptLabel, promptItems]) => (
        <div key={promptLabel} className="group">
          <TimelineDivider
            dateLabel={formatRelativeDate(getFirstCreatedAt(promptItems))}
            outputCount={promptItems.length}
            prompt={stripVariationSections(promptLabel)}
          />
          <MasonryGrid>
            {promptItems.map((item) => {
              const { width, height } = getFrameDimensions(item);
              return (
                <MasonryFrame key={item.id} width={width} height={height}>
                  <GalleryImageCard item={item} />
                </MasonryFrame>
              );
            })}
          </MasonryGrid>
        </div>
      ))}
    </div>
  );
}
