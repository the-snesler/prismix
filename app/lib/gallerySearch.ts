import { cosine } from "./embeddingMath";

/** Cosine similarity at or above which an image counts as a semantic match. */
export const SEMANTIC_THRESHOLD = 0.1;

/** What the gallery is filtered by. Sent as-is to `GalleryRepository.searchImageIds`. */
export interface GallerySearchFilter {
  query: string;
  /** Text embedding of `query`; null when semantic search is off or not ready. */
  queryEmbedding: number[] | null;
  favoritesOnly: boolean;
  characterId: string | null;
}

/** The fields search reads. Gallery items and stored records both fit. */
export interface SearchableImage {
  id: string;
  prompt: string;
  basePrompt?: string;
  modelName: string;
  isFavorite?: boolean;
  characterIds?: string[];
  embedding?: ArrayLike<number>;
}

export function isGalleryFilterActive(filter: GallerySearchFilter): boolean {
  return Boolean(filter.query.trim() || filter.favoritesOnly || filter.characterId);
}

/**
 * Filter and rank images. Favorites and character filters narrow the set. A
 * query keeps prompt/model substring matches and, given a query embedding,
 * images scoring at least `SEMANTIC_THRESHOLD`, best score first (substring
 * matches that have no embedding yet come after scored ones). Otherwise input
 * order is kept.
 *
 * Used both on the gallery's loaded items and by every repository over the full
 * library, so the two always agree.
 */
export function searchImages<T extends SearchableImage>(
  images: Iterable<T>,
  filter: GallerySearchFilter
): T[] {
  const candidates: T[] = [];
  for (const image of images) {
    if (filter.favoritesOnly && !image.isFavorite) continue;
    if (filter.characterId && !image.characterIds?.includes(filter.characterId)) continue;
    candidates.push(image);
  }

  const q = filter.query.trim().toLowerCase();
  if (!q) return candidates;

  const isSubstringMatch = (image: T) =>
    image.prompt.toLowerCase().includes(q) ||
    (image.basePrompt?.toLowerCase().includes(q) ?? false) ||
    image.modelName.toLowerCase().includes(q);

  const queryEmbedding = filter.queryEmbedding;
  if (!queryEmbedding || queryEmbedding.length === 0) return candidates.filter(isSubstringMatch);

  const scored: Array<{ image: T; score: number }> = [];
  const unscored: T[] = [];
  for (const image of candidates) {
    const substring = isSubstringMatch(image);
    if (!image.embedding || image.embedding.length === 0) {
      if (substring) unscored.push(image);
      continue;
    }
    const score = cosine(queryEmbedding, image.embedding);
    if (substring || score >= SEMANTIC_THRESHOLD) scored.push({ image, score });
  }
  // Array.prototype.sort is stable, so equal scores keep input order.
  scored.sort((a, b) => b.score - a.score);
  return [...scored.map((s) => s.image), ...unscored];
}
