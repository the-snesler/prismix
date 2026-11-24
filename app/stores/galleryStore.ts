import { create } from "zustand";
import type {
  BaseGalleryItem,
  GalleryItem,
  CompletedGalleryItem,
  CompletedGalleryItemFields,
  FailedGalleryItemFields,
  ImageScorecard,
  PendingGalleryItemFields,
} from "~/types";
import {
  getImagesByIds,
  getImagesPaginated,
  getImageCount,
  revokeImageUrl,
  searchImageIds,
  PAGE_SIZE,
  deleteImage as dbDeleteImage,
  deleteReferenceImage,
  updateImageFavorite,
  updateImageCharacters as dbUpdateImageCharacters,
  updateImageScorecard,
} from "~/lib/db";
import { useLightboxStore } from "./lightboxStore";
import { useEmbeddingStatusStore } from "./embeddingStatusStore";
import { enqueueMissingEmbeddings, refreshEmbeddingCounts } from "~/lib/embeddingQueue";
import { useSettingsStore } from "./settingsStore";
import { imageFileExtension } from "~/lib/util";
import { isGalleryFilterActive, type GallerySearchFilter } from "~/lib/gallerySearch";

function maybeKickEmbeddingQueue() {
  if (typeof window === "undefined") return;
  if (!useSettingsStore.getState().semanticSearchEnabled) {
    refreshEmbeddingCounts(null);
    return;
  }
  const modelId = useEmbeddingStatusStore.getState().modelId;
  enqueueMissingEmbeddings(modelId);
  refreshEmbeddingCounts(modelId);
}

function getOrphanedReferenceIds(removingIds: Set<string>, allItems: GalleryItem[]): string[] {
  const styles = useSettingsStore.getState().styles;
  const characters = useSettingsStore.getState().characters;
  const removingRefs = new Set(
    allItems
      .filter((i) => removingIds.has(i.id))
      .flatMap((i) => [...i.referenceImageIds, ...(i.manualReferenceImageIds ?? [])])
  );
  const remainingRefs = new Set([
    ...allItems
      .filter((i) => !removingIds.has(i.id))
      .flatMap((i) => [...i.referenceImageIds, ...(i.manualReferenceImageIds ?? [])]),
    ...styles.flatMap((s) => s.referenceImageId),
    ...characters.flatMap((c) => c.referenceImageIds),
  ]);
  return [...removingRefs].filter((id) => !remainingRefs.has(id));
}

const canceledItemIds = new Set<string>();

/**
 * Items loaded only because they matched a search, i.e. older than the
 * paginated prefix of `items`. Pruned when the filter clears so the unfiltered
 * grid stays a contiguous newest-first list.
 */
const searchOnlyItemIds = new Set<string>();
let searchSeq = 0;
let searchLoadInFlight: number | null = null;
let lastSearchFilter: GallerySearchFilter | null = null;

/** Repository search results for the active gallery filter. */
export interface GallerySearchResults {
  /** The filter these results are for (compared by identity). */
  filter: GallerySearchFilter;
  /** Every matching image in the library, best match first. */
  rankedIds: string[];
  /** `rankedIds[0..coveredCount)` have all been loaded into `items`. */
  coveredCount: number;
}

type GalleryItemUpdate = Partial<BaseGalleryItem> &
  (PendingGalleryItemFields | CompletedGalleryItemFields | FailedGalleryItemFields);

interface GalleryState {
  items: GalleryItem[];
  selectedItemIds: string[];
  lastSelectedId: string | null;
  isLoading: boolean;
  hasLoaded: boolean;
  dbOffset: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  totalCount: number;
  searchQuery: string;
  showFavoritesOnly: boolean;
  characterFilter: string | null;
  search: GallerySearchResults | null;

  loadImages: () => Promise<void>;
  loadMoreImages: () => Promise<void>;
  addItem: (item: GalleryItem) => void;
  addItems: (items: GalleryItem[]) => void;
  updateItem: (id: string, updates: GalleryItemUpdate) => void;
  updatePendingPromptFields: (
    updates: Array<{
      id: string;
      prompt: string;
      basePrompt?: string;
      variationReplacements?: string[];
    }>
  ) => void;
  updatePendingPhase: (ids: string[], pendingPhase?: "writing" | "variating") => void;
  deleteItem: (id: string) => Promise<void>;
  dismissItem: (id: string) => void;
  cancelItem: (id: string) => void;
  isItemCanceled: (id: string) => boolean;
  getItem: (id: string) => GalleryItem | undefined;
  toggleItemSelection: (id: string) => void;
  selectItemRange: (id: string) => void;
  clearSelection: () => void;
  deleteSelectedItems: () => Promise<number>;
  downloadSelectedItems: () => number;
  toggleItemFavorite: (id: string) => Promise<void>;
  setSelectedItemsFavorite: (isFavorite: boolean) => Promise<number>;
  setSearchQuery: (query: string) => void;
  toggleFavoritesFilter: () => void;
  setCharacterFilter: (id: string | null) => void;
  /** Search the whole library for `filter` (null or inactive clears the search). */
  runSearch: (filter: GallerySearchFilter | null) => Promise<void>;
  loadMoreSearchResults: () => Promise<void>;
  updateImageCharacters: (id: string, characterIds: string[]) => Promise<void>;
  setItemEmbedding: (id: string, embedding: number[], embeddingModelId: string) => void;
  updateScorecard: (id: string, scorecard: ImageScorecard | undefined) => Promise<void>;
}

export const useGalleryStore = create<GalleryState>()((set, get) => {
  /** Drop search-only items, except those in `keep`, selected, or open in the lightbox. */
  const pruneSearchOnlyItems = (keep: Set<string>) => {
    const target = useLightboxStore.getState().lightboxTarget;
    const openId = target?.kind === "gallery" ? target.imageId : null;
    const selected = new Set(get().selectedItemIds);
    const removing = new Set<string>();
    for (const id of searchOnlyItemIds) {
      if (keep.has(id) || selected.has(id) || id === openId) continue;
      removing.add(id);
      searchOnlyItemIds.delete(id);
    }
    if (removing.size === 0) return;
    for (const item of get().items) {
      if (removing.has(item.id) && item.status === "completed") revokeImageUrl(item);
    }
    set((state) => ({ items: state.items.filter((item) => !removing.has(item.id)) }));
  };

  return {
    items: [],
    selectedItemIds: [],
    lastSelectedId: null,
    isLoading: false,
    hasLoaded: false,
    dbOffset: 0,
    hasMore: false,
    isLoadingMore: false,
    totalCount: 0,
    searchQuery: "",
    showFavoritesOnly: false,
    characterFilter: null,
    search: null,

    loadImages: async () => {
      set({ isLoading: true });
      try {
        const [items, total] = await Promise.all([
          getImagesPaginated(PAGE_SIZE, 0),
          getImageCount(),
        ]);
        searchOnlyItemIds.clear();
        set({
          items,
          hasLoaded: true,
          dbOffset: PAGE_SIZE,
          hasMore: items.length >= PAGE_SIZE,
          totalCount: total,
          search: null,
        });
        maybeKickEmbeddingQueue();
        // Items were replaced, so re-fetch the active search's results.
        if (lastSearchFilter) void get().runSearch(lastSearchFilter);
      } catch (error) {
        console.error("Failed to load images:", error);
      } finally {
        set({ isLoading: false });
      }
    },

    loadMoreImages: async () => {
      const { dbOffset, hasMore, isLoadingMore } = get();
      if (!hasMore || isLoadingMore) return;

      set({ isLoadingMore: true });
      try {
        const newItems = await getImagesPaginated(PAGE_SIZE, dbOffset);

        const existing = new Map(get().items.map((i) => [i.id, i]));
        // Search-only items kept after a search (selected or in the lightbox) move
        // to their place in the page so the grid stays in order.
        const moved = new Set<string>();
        const page: GalleryItem[] = [];
        for (const item of newItems) {
          const prev = existing.get(item.id);
          if (!prev) {
            page.push(item);
            continue;
          }
          revokeImageUrl(item);
          if (searchOnlyItemIds.delete(item.id)) {
            moved.add(item.id);
            page.push(prev);
          }
        }

        set((state) => ({
          items: [...state.items.filter((i) => !moved.has(i.id)), ...page],
          dbOffset: state.dbOffset + newItems.length,
          hasMore: newItems.length >= PAGE_SIZE,
        }));
      } catch (error) {
        console.error("Failed to load more images:", error);
      } finally {
        set({ isLoadingMore: false });
      }
    },

    addItem: (item) => {
      canceledItemIds.delete(item.id);
      set((state) => ({
        items: [item, ...state.items],
      }));
    },

    addItems: (newItems) => {
      newItems.forEach((item) => canceledItemIds.delete(item.id));
      set((state) => ({
        items: [...newItems, ...state.items],
      }));
    },

    updateItem: (id, updates) =>
      set((state) => {
        if (canceledItemIds.has(id)) return state;
        const existing = state.items.find((item) => item.id === id);
        if (!existing) return state;
        const becomingCompleted =
          updates.status === "completed" && existing?.status !== "completed";
        return {
          items: state.items.map((item) => (item.id === id ? { ...item, ...updates } : item)),
          totalCount: becomingCompleted ? state.totalCount + 1 : state.totalCount,
        };
      }),

    updatePendingPromptFields: (updates) =>
      set((state) => {
        const byId = new Map(updates.map((u) => [u.id, u]));
        return {
          items: state.items.map((item) => {
            const u = byId.get(item.id);
            if (!u) return item;
            return {
              ...item,
              prompt: u.prompt,
              basePrompt: u.basePrompt,
              variationReplacements: u.variationReplacements,
            };
          }),
        };
      }),

    updatePendingPhase: (ids, pendingPhase) =>
      set((state) => {
        const idSet = new Set(ids);
        return {
          items: state.items.map((item) => {
            if (!idSet.has(item.id)) return item;
            if (item.status !== "pending") return item;
            return {
              ...item,
              pendingPhase,
            };
          }),
        };
      }),

    deleteItem: async (id) => {
      const state = get();
      const item = state.items.find((i) => i.id === id);
      const orphanedRefIds = getOrphanedReferenceIds(new Set([id]), state.items);

      try {
        await dbDeleteImage(id);
        if (item?.status === "completed") {
          URL.revokeObjectURL(item.originalUrl);
          URL.revokeObjectURL(item.thumbnailUrl);
        }
        const lightboxTarget = useLightboxStore.getState().lightboxTarget;
        const shouldCloseLightbox =
          lightboxTarget?.kind === "gallery" && lightboxTarget.imageId === id;

        const wasCompleted = item?.status === "completed";
        set((state) => ({
          items: state.items.filter((i) => i.id !== id),
          selectedItemIds: state.selectedItemIds.filter((selectedId) => selectedId !== id),
          totalCount: wasCompleted ? state.totalCount - 1 : state.totalCount,
        }));
        if (shouldCloseLightbox) {
          useLightboxStore.getState().closeLightbox();
        }
        await Promise.all(orphanedRefIds.map((refId) => deleteReferenceImage(refId)));
      } catch (error) {
        console.error("Failed to delete image:", error);
        throw error;
      }
    },

    dismissItem: (id) => {
      const state = get();
      const orphanedRefIds = getOrphanedReferenceIds(new Set([id]), state.items);
      void Promise.all(orphanedRefIds.map((refId) => deleteReferenceImage(refId)));
      set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
    },

    cancelItem: (id) => {
      const state = get();
      const item = state.items.find((i) => i.id === id);
      if (!item || item.status === "completed") return;

      canceledItemIds.add(id);
      const orphanedRefIds = getOrphanedReferenceIds(new Set([id]), state.items);
      void Promise.all(orphanedRefIds.map((refId) => deleteReferenceImage(refId)));
      set((s) => ({
        items: s.items.filter((i) => i.id !== id),
        selectedItemIds: s.selectedItemIds.filter((selectedId) => selectedId !== id),
      }));
    },

    isItemCanceled: (id) => canceledItemIds.has(id),

    getItem: (id) => get().items.find((i) => i.id === id),

    toggleItemSelection: (id) =>
      set((state) => {
        const item = state.items.find((entry) => entry.id === id);
        if (!item || item.status !== "completed") {
          return state;
        }

        const isSelected = state.selectedItemIds.includes(id);
        return {
          selectedItemIds: isSelected
            ? state.selectedItemIds.filter((selectedId) => selectedId !== id)
            : [...state.selectedItemIds, id],
          lastSelectedId: id,
        };
      }),

    selectItemRange: (id) =>
      set((state) => {
        const item = state.items.find((entry) => entry.id === id);
        if (!item || item.status !== "completed") {
          return state;
        }

        const completedItems = state.items.filter(
          (i): i is CompletedGalleryItem => i.status === "completed"
        );

        const anchorIndex = state.lastSelectedId
          ? completedItems.findIndex((i) => i.id === state.lastSelectedId)
          : -1;

        // No anchor — fall back to single select
        if (anchorIndex === -1) {
          const isSelected = state.selectedItemIds.includes(id);
          return {
            selectedItemIds: isSelected
              ? state.selectedItemIds.filter((sid) => sid !== id)
              : [...state.selectedItemIds, id],
            lastSelectedId: id,
          };
        }

        const targetIndex = completedItems.findIndex((i) => i.id === id);
        if (targetIndex === -1) return state;

        const start = Math.min(anchorIndex, targetIndex);
        const end = Math.max(anchorIndex, targetIndex);
        const rangeIds = completedItems.slice(start, end + 1).map((i) => i.id);

        const merged = new Set([...state.selectedItemIds, ...rangeIds]);
        return {
          selectedItemIds: Array.from(merged),
          lastSelectedId: id,
        };
      }),

    clearSelection: () => set({ selectedItemIds: [], lastSelectedId: null }),

    setSearchQuery: (query) => set({ searchQuery: query }),

    toggleFavoritesFilter: () => set((state) => ({ showFavoritesOnly: !state.showFavoritesOnly })),

    setCharacterFilter: (id) => set({ characterFilter: id }),

    runSearch: async (filter) => {
      const seq = ++searchSeq;
      if (!filter || !isGalleryFilterActive(filter)) {
        lastSearchFilter = null;
        set({ search: null });
        pruneSearchOnlyItems(new Set());
        return;
      }
      lastSearchFilter = filter;
      try {
        const rankedIds = await searchImageIds(filter);
        if (seq !== searchSeq) return;
        pruneSearchOnlyItems(new Set(rankedIds));
        set({ search: { filter, rankedIds, coveredCount: 0 } });
        await get().loadMoreSearchResults();
      } catch (error) {
        console.error("Failed to search images:", error);
        // Settle on loaded matches only rather than looking like it's still searching.
        if (seq === searchSeq) set({ search: { filter, rankedIds: [], coveredCount: 0 } });
      }
    },

    loadMoreSearchResults: async () => {
      const { search } = get();
      const seq = searchSeq;
      if (!search || searchLoadInFlight === seq) return;
      if (search.coveredCount >= search.rankedIds.length) return;

      searchLoadInFlight = seq;
      set({ isLoadingMore: true });
      try {
        // Walk the ranking until PAGE_SIZE results that aren't loaded yet.
        const loaded = new Set(get().items.map((i) => i.id));
        const missing: string[] = [];
        let end = search.coveredCount;
        while (end < search.rankedIds.length && missing.length < PAGE_SIZE) {
          const id = search.rankedIds[end++];
          if (!loaded.has(id)) missing.push(id);
        }

        const fetched = await getImagesByIds(missing);
        if (seq !== searchSeq) {
          fetched.forEach(revokeImageUrl);
          return;
        }
        const present = new Set(get().items.map((i) => i.id));
        const fresh: CompletedGalleryItem[] = [];
        for (const item of fetched) {
          if (present.has(item.id)) {
            revokeImageUrl(item);
            continue;
          }
          searchOnlyItemIds.add(item.id);
          fresh.push(item);
        }
        set((state) => ({
          items: [...state.items, ...fresh],
          search: state.search ? { ...state.search, coveredCount: end } : null,
        }));
      } catch (error) {
        console.error("Failed to load search results:", error);
      } finally {
        if (searchLoadInFlight === seq) {
          searchLoadInFlight = null;
          set({ isLoadingMore: false });
        }
      }
    },

    updateImageCharacters: async (id, characterIds) => {
      await dbUpdateImageCharacters(id, characterIds);
      const nextIds = characterIds.length > 0 ? characterIds : undefined;
      set((state) => ({
        items: state.items.map((item) =>
          item.id === id ? { ...item, characterIds: nextIds } : item
        ),
      }));
    },

    setItemEmbedding: (id, embedding, embeddingModelId) =>
      set((state) => ({
        items: state.items.map((item) =>
          item.id === id && item.status === "completed"
            ? { ...item, embedding, embeddingModelId }
            : item
        ),
      })),

    toggleItemFavorite: async (id) => {
      const item = get().items.find((entry) => entry.id === id);
      if (!item || item.status !== "completed") return;

      const nextIsFavorite = !item.isFavorite;
      set((state) => ({
        items: state.items.map((entry) =>
          entry.id === id && entry.status === "completed"
            ? { ...entry, isFavorite: nextIsFavorite }
            : entry
        ),
      }));

      try {
        await updateImageFavorite(id, nextIsFavorite);
      } catch (error) {
        set((state) => ({
          items: state.items.map((entry) =>
            entry.id === id && entry.status === "completed"
              ? { ...entry, isFavorite: item.isFavorite ?? false }
              : entry
          ),
        }));
        console.error("Failed to update favorite:", error);
        throw error;
      }
    },

    setSelectedItemsFavorite: async (isFavorite) => {
      const state = get();
      const selectedSet = new Set(state.selectedItemIds);
      const selectedItems = state.items.filter(
        (item): item is CompletedGalleryItem =>
          item.status === "completed" && selectedSet.has(item.id)
      );

      if (selectedItems.length === 0) {
        return 0;
      }

      const previousFavorites = new Map(
        selectedItems.map((item) => [item.id, item.isFavorite ?? false])
      );

      set((currentState) => ({
        items: currentState.items.map((item) =>
          item.status === "completed" && selectedSet.has(item.id) ? { ...item, isFavorite } : item
        ),
      }));

      try {
        await Promise.all(selectedItems.map((item) => updateImageFavorite(item.id, isFavorite)));
        return selectedItems.length;
      } catch (error) {
        set((currentState) => ({
          items: currentState.items.map((item) =>
            item.status === "completed" && previousFavorites.has(item.id)
              ? { ...item, isFavorite: previousFavorites.get(item.id) ?? false }
              : item
          ),
        }));
        console.error("Failed to update selected favorites:", error);
        throw error;
      }
    },

    updateScorecard: async (id, scorecard) => {
      const record = await updateImageScorecard(id, scorecard);
      if (!record) return;

      set((state) => ({
        items: state.items.map((item) => {
          if (item.id !== id || item.status !== "completed") return item;
          if (scorecard) return { ...item, scorecard };

          const { scorecard: _scorecard, ...rest } = item;
          void _scorecard;
          return rest;
        }),
      }));
    },

    deleteSelectedItems: async () => {
      const state = get();
      const selectedSet = new Set(state.selectedItemIds);
      const selectedItems = state.items.filter(
        (item): item is CompletedGalleryItem =>
          item.status === "completed" && selectedSet.has(item.id)
      );

      if (selectedItems.length === 0) {
        return 0;
      }

      const orphanedRefIds = getOrphanedReferenceIds(selectedSet, state.items);

      await Promise.all(selectedItems.map((item) => dbDeleteImage(item.id)));
      selectedItems.forEach((item) => {
        URL.revokeObjectURL(item.originalUrl);
        URL.revokeObjectURL(item.thumbnailUrl);
      });

      const lightboxTarget = useLightboxStore.getState().lightboxTarget;
      const shouldCloseLightbox =
        lightboxTarget?.kind === "gallery" && selectedSet.has(lightboxTarget.imageId);

      set((currentState) => ({
        items: currentState.items.filter((item) => !selectedSet.has(item.id)),
        selectedItemIds: [],
        totalCount: currentState.totalCount - selectedItems.length,
      }));
      if (shouldCloseLightbox) {
        useLightboxStore.getState().closeLightbox();
      }
      await Promise.all(orphanedRefIds.map((refId) => deleteReferenceImage(refId)));

      return selectedItems.length;
    },

    downloadSelectedItems: () => {
      const state = get();
      const selectedSet = new Set(state.selectedItemIds);
      const selectedItems = state.items.filter(
        (item): item is CompletedGalleryItem =>
          item.status === "completed" && selectedSet.has(item.id)
      );

      selectedItems.forEach((item, index) => {
        const extension = imageFileExtension(item.originalMimeType);
        const link = document.createElement("a");
        link.href = item.originalUrl;
        link.download = `${sanitizeFilename(item.modelName)}-${item.createdAt}-${index + 1}.${extension}`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      });

      return selectedItems.length;
    },
  };
});

function sanitizeFilename(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "image"
  );
}
