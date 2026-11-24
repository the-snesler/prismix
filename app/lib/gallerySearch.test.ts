import { describe, expect, it } from "vitest";
import {
  isGalleryFilterActive,
  searchImages,
  type GallerySearchFilter,
  type SearchableImage,
} from "./gallerySearch";

const filter = (overrides: Partial<GallerySearchFilter> = {}): GallerySearchFilter => ({
  query: "",
  queryEmbedding: null,
  favoritesOnly: false,
  characterId: null,
  ...overrides,
});

const image = (id: string, overrides: Partial<SearchableImage> = {}): SearchableImage => ({
  id,
  prompt: id,
  modelName: "Model",
  ...overrides,
});

const ids = (images: SearchableImage[]) => images.map((i) => i.id);

describe("isGalleryFilterActive", () => {
  it("ignores a whitespace query and an embedding on its own", () => {
    expect(isGalleryFilterActive(filter({ query: "  ", queryEmbedding: [1] }))).toBe(false);
    expect(isGalleryFilterActive(filter({ favoritesOnly: true }))).toBe(true);
    expect(isGalleryFilterActive(filter({ characterId: "char-1" }))).toBe(true);
  });
});

describe("searchImages", () => {
  it("keeps input order for favorites and character filters", () => {
    const images = [
      image("a", { isFavorite: true, characterIds: ["c1"] }),
      image("b", { isFavorite: true }),
      image("c", { characterIds: ["c1"] }),
    ];
    expect(ids(searchImages(images, filter({ favoritesOnly: true })))).toEqual(["a", "b"]);
    expect(ids(searchImages(images, filter({ characterId: "c1" })))).toEqual(["a", "c"]);
  });

  it("matches prompt, base prompt, and model name case-insensitively", () => {
    const images = [
      image("red fox"),
      image("x", { basePrompt: "a {{RED}} car" }),
      image("y", { modelName: "Redshift" }),
      image("blue"),
    ];
    expect(ids(searchImages(images, filter({ query: " Red " })))).toEqual(["red fox", "x", "y"]);
  });

  it("ranks by similarity with an embedding, keeping substring matches", () => {
    const images = [
      image("far", { embedding: [0, 1] }),
      image("near", { embedding: [1, 0.1] }),
      image("cat literal", { embedding: [-1, 0] }),
      image("cat unembedded"),
      image("unrelated unembedded"),
    ];
    const result = searchImages(images, filter({ query: "cat", queryEmbedding: [1, 0] }));
    expect(ids(result)).toEqual(["near", "cat literal", "cat unembedded"]);
  });
});
