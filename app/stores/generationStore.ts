import { create } from "zustand";
import type {
  AspectRatio,
  ModelOptionId,
  ModelOptionValues,
  ReferenceImage,
  Resolution,
} from "~/types";

interface GenerationState {
  currentPrompt: string;
  currentBasePrompt: string | null;
  reuseSentPrompt: boolean;
  currentModelSelections: Record<string, number>;
  currentAspectRatio: AspectRatio | null;
  currentResolution: Resolution;
  currentQuality: string | null;
  currentNumberOfImages: number;
  /** Raw per-model option picks, keyed by model ID. Resolve with `resolveModelOptions`. */
  currentModelOptions: Record<string, ModelOptionValues>;
  currentReferenceImages: ReferenceImage[];
  currentStyleId: string | null;
  currentCharacterIds: string[];
  variationsEnabled: boolean;
  avoidPastVariations: boolean;
  activeGenerationCount: number;
  activeGenerationSignatures: Record<string, number>;
  lastSubmittedSignature: string | null;
  isGenerating: boolean;

  setPrompt: (prompt: string) => void;
  setBasePrompt: (prompt: string | null) => void;
  setModelCount: (modelId: string, count: number) => void;
  setAspectRatio: (ratio: AspectRatio | null) => void;
  setResolution: (resolution: Resolution) => void;
  setQuality: (quality: string | null) => void;
  setNumberOfImages: (count: number) => void;
  /** Set one option for one model; `undefined` clears it back to the default. */
  setModelOption: (
    modelId: string,
    optionId: ModelOptionId,
    value: string | number | undefined
  ) => void;
  setVariationsEnabled: (enabled: boolean) => void;
  setAvoidPastVariations: (enabled: boolean) => void;
  addReferenceImage: (image: ReferenceImage) => void;
  addReferenceImages: (images: ReferenceImage[]) => void;
  replaceReferenceImage: (id: string, image: Omit<ReferenceImage, "id">) => void;
  removeReferenceImage: (id: string) => void;
  reorderReferenceImages: (fromId: string, toId: string) => void;
  clearReferenceImages: () => void;
  setStyleId: (id: string | null) => void;
  setCharacterIds: (ids: string[]) => void;
  startGeneration: (signature: string) => void;
  finishGeneration: (signature: string) => void;
  resetDraft: () => void;
}

export const DEFAULT_GENERATION_STATE = {
  currentPrompt: "",
  currentBasePrompt: null as string | null,
  reuseSentPrompt: false,
  currentModelSelections: {},
  currentAspectRatio: null,
  currentResolution: "1K" as Resolution,
  currentQuality: null as string | null,
  currentNumberOfImages: 1,
  currentModelOptions: {} as Record<string, ModelOptionValues>,
  currentReferenceImages: [],
  currentStyleId: null as string | null,
  currentCharacterIds: [] as string[],
  variationsEnabled: false,
  avoidPastVariations: true,
};

export const useGenerationStore = create<GenerationState>()((set) => ({
  ...DEFAULT_GENERATION_STATE,
  activeGenerationCount: 0,
  activeGenerationSignatures: {},
  lastSubmittedSignature: null,
  isGenerating: false,

  setPrompt: (currentPrompt) =>
    set((state) => ({
      currentPrompt,
      reuseSentPrompt: false,
      currentBasePrompt: currentPrompt.length === 0 ? null : state.currentBasePrompt,
    })),

  setBasePrompt: (currentBasePrompt) => set({ currentBasePrompt }),

  setModelCount: (modelId, count) =>
    set((state) => ({
      currentModelSelections: {
        ...state.currentModelSelections,
        [modelId]: Math.max(0, count),
      },
    })),

  setAspectRatio: (currentAspectRatio) => set({ currentAspectRatio }),

  setResolution: (currentResolution) => set({ currentResolution }),

  setQuality: (currentQuality) => set({ currentQuality }),

  setNumberOfImages: (currentNumberOfImages) =>
    set({ currentNumberOfImages: Math.max(1, Math.min(50, currentNumberOfImages)) }),

  setModelOption: (modelId, optionId, value) =>
    set((state) => {
      const { [optionId]: _previous, ...rest } = state.currentModelOptions[modelId] ?? {};
      return {
        currentModelOptions: {
          ...state.currentModelOptions,
          [modelId]: value === undefined ? rest : { ...rest, [optionId]: value },
        },
      };
    }),

  setVariationsEnabled: (variationsEnabled) => set({ variationsEnabled }),

  setAvoidPastVariations: (avoidPastVariations) => set({ avoidPastVariations }),

  addReferenceImage: (image) =>
    set((state) => ({
      currentReferenceImages: [...state.currentReferenceImages, image],
    })),

  addReferenceImages: (images) =>
    set((state) => ({
      currentReferenceImages: [...state.currentReferenceImages, ...images],
    })),

  replaceReferenceImage: (id, image) =>
    set((state) => {
      const previous = state.currentReferenceImages.find((entry) => entry.id === id);
      if (!previous) return {};
      URL.revokeObjectURL(previous.url);
      return {
        currentReferenceImages: state.currentReferenceImages.map((entry) =>
          entry.id === id ? { ...image, id } : entry
        ),
      };
    }),

  removeReferenceImage: (id) =>
    set((state) => {
      const image = state.currentReferenceImages.find((entry) => entry.id === id);
      if (image) {
        URL.revokeObjectURL(image.url);
      }
      return {
        currentReferenceImages: state.currentReferenceImages.filter((entry) => entry.id !== id),
      };
    }),

  reorderReferenceImages: (fromId, toId) =>
    set((state) => {
      const images = [...state.currentReferenceImages];
      const fromIndex = images.findIndex((img) => img.id === fromId);
      const toIndex = images.findIndex((img) => img.id === toId);
      if (fromIndex === -1 || toIndex === -1) return {};
      const [moved] = images.splice(fromIndex, 1);
      images.splice(toIndex, 0, moved);
      return { currentReferenceImages: images };
    }),

  clearReferenceImages: () =>
    set((state) => {
      state.currentReferenceImages.forEach((image) => URL.revokeObjectURL(image.url));
      return { currentReferenceImages: [] };
    }),

  setStyleId: (currentStyleId) => set({ currentStyleId }),

  setCharacterIds: (currentCharacterIds) => set({ currentCharacterIds }),

  startGeneration: (signature) =>
    set((state) => {
      const nextCount = state.activeGenerationCount + 1;
      return {
        activeGenerationCount: nextCount,
        activeGenerationSignatures: {
          ...state.activeGenerationSignatures,
          [signature]: (state.activeGenerationSignatures[signature] ?? 0) + 1,
        },
        lastSubmittedSignature: signature,
        isGenerating: nextCount > 0,
      };
    }),

  finishGeneration: (signature) =>
    set((state) => {
      const nextCount = Math.max(0, state.activeGenerationCount - 1);
      const currentSignatureCount = state.activeGenerationSignatures[signature] ?? 0;
      const nextSignatureCount = Math.max(0, currentSignatureCount - 1);
      const nextSignatures = { ...state.activeGenerationSignatures };

      if (nextSignatureCount === 0) {
        delete nextSignatures[signature];
      } else {
        nextSignatures[signature] = nextSignatureCount;
      }

      return {
        activeGenerationCount: nextCount,
        activeGenerationSignatures: nextSignatures,
        isGenerating: nextCount > 0,
      };
    }),

  resetDraft: () =>
    set((state) => {
      state.currentReferenceImages.forEach((image) => URL.revokeObjectURL(image.url));
      return {
        ...DEFAULT_GENERATION_STATE,
      };
    }),
}));
