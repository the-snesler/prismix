import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  BUILT_IN_MODELS,
  BUILT_IN_TEXT_MODELS,
  BUILT_IN_UPSCALERS,
  getLibraryCapabilities,
  mergeWithBuiltInModels,
  mergeWithBuiltInTextModels,
  mergeWithBuiltInUpscalers,
} from "~/lib/builtInModels";
import { BUILT_IN_STYLES, mergeWithBuiltInStyles } from "~/lib/builtInStyles";
import { hasProviderAccess } from "~/lib/providers";
import {
  deleteReferenceImagesByIds,
  garbageCollectReferences,
  removeImageStyleReferences,
} from "~/lib/db";
import { useGalleryStore } from "./galleryStore";
import { useGenerationStore } from "./generationStore";
import { useEditorStore } from "./editorStore";
import type {
  ApiKeyProvider,
  ApiKeys,
  ModelCapabilities,
  SchemaMapping,
  StoredCharacter,
  StoredModel,
  StoredStyle,
  StoredTextModel,
  StoredUpscaler,
} from "~/types";

interface SettingsState {
  apiKeys: ApiKeys;
  models: StoredModel[];
  textModels: StoredTextModel[];
  upscalers: StoredUpscaler[];
  styles: StoredStyle[];
  characters: StoredCharacter[];
  desktopNotificationsEnabled: boolean;
  notificationPromptDismissed: boolean;
  requestedOutputCount: number;
  editorContextInjectionEnabled: boolean;
  alwaysImprovePromptEnabled: boolean;
  semanticSearchEnabled: boolean;

  // API key actions
  setApiKey: (provider: ApiKeyProvider, key: string | null) => void;
  clearApiKey: (provider: ApiKeyProvider) => void;

  // Model actions
  setModelEnabled: (id: string, enabled: boolean) => void;
  addCustomModel: (
    provider: ApiKeyProvider,
    id: string,
    name: string,
    capabilities: ModelCapabilities,
    schemaMapping?: SchemaMapping,
    icon?: string
  ) => void;
  removeCustomModel: (id: string) => void;
  reorderModels: (activeId: string, overId: string) => void;
  updateModelCapabilities: (
    id: string,
    capabilities: ModelCapabilities,
    schemaFetched?: boolean
  ) => void;
  updateModelSchemaMapping: (id: string, schemaMapping: SchemaMapping) => void;

  // Upscaler actions
  setUpscalerEnabled: (id: string, enabled: boolean) => void;
  addCustomUpscaler: (replicateId: string, name: string, icon?: string) => void;
  removeCustomUpscaler: (id: string) => void;
  reorderUpscalers: (activeId: string, overId: string) => void;

  // Style actions
  setStyleEnabled: (id: string, enabled: boolean) => void;
  addCustomStyle: (input: { name: string; text: string; referenceImageId?: string }) => string;
  updateStyle: (
    id: string,
    patch: Partial<Pick<StoredStyle, "name" | "text" | "referenceImageId">>
  ) => void;
  removeCustomStyle: (id: string) => Promise<void>;
  reorderStyles: (activeId: string, overId: string) => void;

  // Character actions
  setCharacterEnabled: (id: string, enabled: boolean) => void;
  addCharacter: (input: { name: string; text: string; referenceImageIds?: string[] }) => string;
  updateCharacter: (
    id: string,
    patch: Partial<Pick<StoredCharacter, "name" | "text" | "referenceImageIds" | "icon">>
  ) => void;
  removeCharacter: (id: string) => void;
  reorderCharacters: (activeId: string, overId: string) => void;
  importCharacters: (characters: StoredCharacter[]) => void;
  importCustomStyles: (styles: StoredStyle[]) => void;

  // Text model actions
  selectTextModel: (id: string) => void;
  addCustomTextModel: (
    provider: ApiKeyProvider,
    modelId: string,
    name: string,
    icon?: string
  ) => void;
  removeCustomTextModel: (id: string) => void;

  // Notification actions
  setDesktopNotificationsEnabled: (enabled: boolean) => void;
  dismissNotificationPrompt: () => void;
  incrementRequestedOutputCount: (count?: number) => void;

  // Editor context injection
  setEditorContextInjectionEnabled: (enabled: boolean) => void;

  // Always improve prompt
  setAlwaysImprovePromptEnabled: (enabled: boolean) => void;

  // Semantic search
  setSemanticSearchEnabled: (enabled: boolean) => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      apiKeys: {
        google: null,
        replicate: null,
        openai: null,
        openrouter: null,
      },
      models: BUILT_IN_MODELS,
      textModels: BUILT_IN_TEXT_MODELS,
      upscalers: BUILT_IN_UPSCALERS,
      styles: BUILT_IN_STYLES,
      characters: [],
      desktopNotificationsEnabled: false,
      notificationPromptDismissed: false,
      requestedOutputCount: 0,
      editorContextInjectionEnabled: true,
      alwaysImprovePromptEnabled: false,
      semanticSearchEnabled: false,

      setApiKey: (provider, key) =>
        set((state) => ({
          apiKeys: { ...state.apiKeys, [provider]: key },
        })),

      clearApiKey: (provider) =>
        set((state) => ({
          apiKeys: { ...state.apiKeys, [provider]: null },
        })),

      setModelEnabled: (id, enabled) =>
        set((state) => ({
          models: state.models.map((m) => (m.id === id ? { ...m, enabled } : m)),
        })),

      addCustomModel: (provider, id, name, capabilities, schemaMapping, icon) =>
        set((state) => ({
          models: [
            ...state.models,
            {
              id: `${provider}/${id}`,
              name,
              provider,
              enabled: true,
              isCustom: true,
              schemaFetched: true,
              capabilities,
              ...(schemaMapping && { schemaMapping }),
              ...(icon && { icon }),
            },
          ],
        })),

      removeCustomModel: (id) =>
        set((state) => ({
          models: state.models.some((m) => m.id === id && m.isCustom)
            ? state.models.filter((m) => m.id !== id)
            : state.models,
        })),

      reorderModels: (activeId, overId) =>
        set((state) => {
          const oldIndex = state.models.findIndex((m) => m.id === activeId);
          const newIndex = state.models.findIndex((m) => m.id === overId);
          if (oldIndex === -1 || newIndex === -1) return state;
          const newModels = [...state.models];
          const [moved] = newModels.splice(oldIndex, 1);
          newModels.splice(newIndex, 0, moved);
          return { models: newModels };
        }),

      updateModelCapabilities: (id, capabilities, schemaFetched) =>
        set((state) => ({
          models: state.models.map((m) =>
            m.id === id
              ? { ...m, capabilities, ...(schemaFetched !== undefined && { schemaFetched }) }
              : m
          ),
        })),

      updateModelSchemaMapping: (id, schemaMapping) =>
        set((state) => ({
          models: state.models.map((m) => (m.id === id ? { ...m, schemaMapping } : m)),
        })),

      selectTextModel: (id) =>
        set((state) => {
          if (!state.textModels.some((m) => m.id === id)) return state;
          return {
            textModels: state.textModels.map((m) => ({ ...m, enabled: m.id === id })),
          };
        }),

      addCustomTextModel: (provider, modelId, name, icon) =>
        set((state) => {
          const id = `${provider}:${modelId}`;
          if (state.textModels.some((m) => m.id === id)) return state;
          const newModel: StoredTextModel = {
            id,
            name,
            provider,
            modelId,
            enabled: true,
            isCustom: true,
            ...(icon && { icon }),
          };
          return {
            textModels: [...state.textModels.map((m) => ({ ...m, enabled: false })), newModel],
          };
        }),

      removeCustomTextModel: (id) =>
        set((state) => {
          const target = state.textModels.find((m) => m.id === id);
          if (!target || !target.isCustom) return state;
          const remaining = state.textModels.filter((m) => m.id !== id);
          if (target.enabled && remaining.length > 0) {
            remaining[0] = { ...remaining[0], enabled: true };
          }
          return { textModels: remaining };
        }),

      setUpscalerEnabled: (id, enabled) =>
        set((state) => ({
          upscalers: state.upscalers.map((u) => (u.id === id ? { ...u, enabled } : u)),
        })),

      addCustomUpscaler: (replicateId, name, icon) =>
        set((state) => {
          const id = `replicate/${replicateId}`;
          if (state.upscalers.some((u) => u.id === id)) return state;
          return {
            upscalers: [
              ...state.upscalers,
              {
                id,
                name,
                replicateId,
                scale: null,
                scaleParam: null,
                enabled: true,
                isCustom: true,
                ...(icon && { icon }),
              },
            ],
          };
        }),

      removeCustomUpscaler: (id) =>
        set((state) => ({
          upscalers: state.upscalers.some((u) => u.id === id && u.isCustom)
            ? state.upscalers.filter((u) => u.id !== id)
            : state.upscalers,
        })),

      reorderUpscalers: (activeId, overId) =>
        set((state) => {
          const oldIndex = state.upscalers.findIndex((u) => u.id === activeId);
          const newIndex = state.upscalers.findIndex((u) => u.id === overId);
          if (oldIndex === -1 || newIndex === -1) return state;
          const newUpscalers = [...state.upscalers];
          const [moved] = newUpscalers.splice(oldIndex, 1);
          newUpscalers.splice(newIndex, 0, moved);
          return { upscalers: newUpscalers };
        }),

      setStyleEnabled: (id, enabled) =>
        set((state) => ({
          styles: state.styles.map((s) => (s.id === id ? { ...s, enabled } : s)),
        })),

      addCustomStyle: ({ name, text, referenceImageId }) => {
        const id = `custom/${crypto.randomUUID()}`;
        set((state) => ({
          styles: [
            ...state.styles,
            {
              id,
              name,
              text,
              enabled: true,
              isCustom: true,
              ...(referenceImageId && { referenceImageId }),
            },
          ],
        }));
        return id;
      },

      updateStyle: (id, patch) =>
        set((state) => ({
          styles: state.styles.map((s) => {
            if (s.id !== id || !s.isCustom) return s;
            const next: StoredStyle = { ...s };
            if (patch.name !== undefined) next.name = patch.name;
            if (patch.text !== undefined) next.text = patch.text;
            if ("referenceImageId" in patch) {
              if (patch.referenceImageId) {
                next.referenceImageId = patch.referenceImageId;
              } else {
                delete next.referenceImageId;
              }
            }
            return next;
          }),
        })),

      removeCustomStyle: async (id) => {
        if (!get().styles.some((s) => s.id === id && s.isCustom)) return;
        set((state) => ({ styles: state.styles.filter((s) => s.id !== id) }));
        if (useGenerationStore.getState().currentStyleId === id) {
          useGenerationStore.getState().setStyleId(null);
        }
        useGalleryStore.setState((state) => ({
          items: state.items.map((item) =>
            item.styleId === id ? { ...item, styleId: undefined } : item
          ),
        }));
        await removeImageStyleReferences(id);
        const settings = get();
        const draft = useGenerationStore.getState();
        const editor = useEditorStore.getState();
        await garbageCollectReferences([
          ...settings.styles.flatMap((s) => (s.referenceImageId ? [s.referenceImageId] : [])),
          ...settings.characters.flatMap((c) => c.referenceImageIds),
          ...useGalleryStore
            .getState()
            .items.flatMap((item) => [
              ...item.referenceImageIds,
              ...(item.manualReferenceImageIds ?? []),
            ]),
          ...draft.currentReferenceImages.map((r) => r.id),
          ...editor.referenceImages.map((r) => r.id),
          ...(editor.sourceReferenceId ? [editor.sourceReferenceId] : []),
        ]);
      },

      reorderStyles: (activeId, overId) =>
        set((state) => {
          const oldIndex = state.styles.findIndex((s) => s.id === activeId);
          const newIndex = state.styles.findIndex((s) => s.id === overId);
          if (oldIndex === -1 || newIndex === -1) return state;
          const newStyles = [...state.styles];
          const [moved] = newStyles.splice(oldIndex, 1);
          newStyles.splice(newIndex, 0, moved);
          return { styles: newStyles };
        }),

      setCharacterEnabled: (id, enabled) =>
        set((state) => ({
          characters: state.characters.map((c) => (c.id === id ? { ...c, enabled } : c)),
        })),

      addCharacter: ({ name, text, referenceImageIds = [] }) => {
        const id = `char-${crypto.randomUUID()}`;
        set((state) => ({
          characters: [...state.characters, { id, name, text, enabled: true, referenceImageIds }],
        }));
        return id;
      },

      updateCharacter: (id, patch) =>
        set((state) => ({
          characters: state.characters.map((c) => {
            if (c.id !== id) return c;
            return { ...c, ...patch };
          }),
        })),

      removeCharacter: (id) =>
        set((state) => {
          const character = state.characters.find((c) => c.id === id);
          if (character?.referenceImageIds.length) {
            void deleteReferenceImagesByIds(character.referenceImageIds);
          }
          return { characters: state.characters.filter((c) => c.id !== id) };
        }),

      reorderCharacters: (activeId, overId) =>
        set((state) => {
          const oldIndex = state.characters.findIndex((c) => c.id === activeId);
          const newIndex = state.characters.findIndex((c) => c.id === overId);
          if (oldIndex === -1 || newIndex === -1) return state;
          const newCharacters = [...state.characters];
          const [moved] = newCharacters.splice(oldIndex, 1);
          newCharacters.splice(newIndex, 0, moved);
          return { characters: newCharacters };
        }),

      importCharacters: (incoming) =>
        set((state) => {
          const existingIds = new Set(state.characters.map((c) => c.id));
          const newOnes = incoming.filter((c) => !existingIds.has(c.id));
          return newOnes.length ? { characters: [...state.characters, ...newOnes] } : state;
        }),

      importCustomStyles: (incoming) =>
        set((state) => {
          const existingIds = new Set(state.styles.map((s) => s.id));
          const newOnes = incoming.filter((s) => !existingIds.has(s.id));
          return newOnes.length ? { styles: [...state.styles, ...newOnes] } : state;
        }),

      setDesktopNotificationsEnabled: (enabled) => set({ desktopNotificationsEnabled: enabled }),

      dismissNotificationPrompt: () => set({ notificationPromptDismissed: true }),

      setEditorContextInjectionEnabled: (enabled) =>
        set({ editorContextInjectionEnabled: enabled }),

      setAlwaysImprovePromptEnabled: (enabled) => set({ alwaysImprovePromptEnabled: enabled }),

      setSemanticSearchEnabled: (enabled) => set({ semanticSearchEnabled: enabled }),

      incrementRequestedOutputCount: (count = 1) =>
        set((state) => ({
          requestedOutputCount: state.requestedOutputCount + Math.max(0, count),
        })),
    }),
    {
      name: "studio-settings",
      version: 26,
      partialize: (state) => ({
        apiKeys: state.apiKeys,
        models: state.models,
        textModels: state.textModels,
        upscalers: state.upscalers,
        styles: state.styles,
        characters: state.characters,
        desktopNotificationsEnabled: state.desktopNotificationsEnabled,
        notificationPromptDismissed: state.notificationPromptDismissed,
        requestedOutputCount: state.requestedOutputCount,
        editorContextInjectionEnabled: state.editorContextInjectionEnabled,
        alwaysImprovePromptEnabled: state.alwaysImprovePromptEnabled,
        semanticSearchEnabled: state.semanticSearchEnabled,
      }),
      migrate: (persisted, version) => {
        let state = persisted as {
          apiKeys?: ApiKeys;
          models?: StoredModel[];
          textModel?: { provider: ApiKeyProvider; modelId: string };
          textModels?: StoredTextModel[];
          upscalers?: StoredUpscaler[];
          styles?: StoredStyle[];
          characters?: StoredCharacter[];
          desktopNotificationsEnabled?: boolean;
          notificationPromptDismissed?: boolean;
          requestedOutputCount?: number;
          editorContextInjectionEnabled?: boolean;
          alwaysImprovePromptEnabled?: boolean;
          semanticSearchEnabled?: boolean;
        };

        if (version < 3) {
          // Migration from v2: add icons to built-in models
          const iconMap: Record<string, string> = {
            "gemini-2.5-flash-image": "/icons/google.svg",
            "gemini-3-pro-image-preview": "/icons/google.svg",
            "gemini-3.1-flash-image-preview": "/icons/google.svg",
            "replicate/google/nano-banana": "/icons/google.svg",
            "replicate/google/nano-banana-pro": "/icons/google.svg",
            "replicate/openai/gpt-image-1.5": "/icons/openai.svg",
            "gpt-image-2": "/icons/openai.svg",
            "gpt-image-1.5": "/icons/openai.svg",
            "replicate/black-forest-labs/flux-2-flex": "/icons/bfl.svg",
            "replicate/bytedance/seedream-4.5": "/icons/bytedance.svg",
          };

          state = {
            ...state,
            models: state.models?.map((m) => ({
              ...m,
              icon: m.icon ?? iconMap[m.id],
            })),
          };
        }

        if (version < 6) {
          state = {
            ...state,
            textModel: { provider: "google", modelId: "gemini-3-flash-preview" },
            models: state.models?.map((model) => {
              const BUILT_IN_MODEL_IDS = new Set(BUILT_IN_MODELS.map((model) => model.id));
              function isBuiltInModel(id: string): boolean {
                return BUILT_IN_MODEL_IDS.has(id);
              }
              return isBuiltInModel(model.id) ? { ...model, isCustom: undefined } : model;
            }),
            desktopNotificationsEnabled: state.desktopNotificationsEnabled ?? false,
            notificationPromptDismissed: state.notificationPromptDismissed ?? false,
            requestedOutputCount: state.requestedOutputCount ?? 0,
          };
        }

        if (version < 8) {
          state = {
            ...state,
            models: state.models?.map((model) =>
              model.provider === "replicate" && model.isCustom
                ? { ...model, schemaFetched: false }
                : model
            ),
          };
        }

        if (version < 11) {
          // Convert scalar textModel into textModels list.
          const prev = state.textModel;
          const seed = BUILT_IN_TEXT_MODELS.map((m) => ({ ...m, enabled: false }));
          if (prev) {
            const prevId = `${prev.provider}:${prev.modelId}`;
            const existing = seed.find((m) => m.id === prevId);
            if (existing) {
              existing.enabled = true;
            } else {
              seed.push({
                id: prevId,
                name: prev.modelId,
                provider: prev.provider,
                modelId: prev.modelId,
                enabled: true,
                isCustom: true,
                ...(prev.provider === "google" ? { icon: "/icons/google.svg" } : {}),
              });
            }
          } else {
            seed[0] = { ...seed[0], enabled: true };
          }
          state = { ...state, textModels: seed, textModel: undefined };
        }

        if (version < 26) {
          // Custom models added from the model library pick up new library capabilities
          // (e.g. GPT Image 2.6 options). Built-ins are refreshed by mergeWithBuiltInModels.
          state = {
            ...state,
            models: state.models?.map((model) => {
              const capabilities = model.isCustom ? getLibraryCapabilities(model.id) : undefined;
              return capabilities ? { ...model, capabilities } : model;
            }),
          };
        }

        // kinda duplicating our default state here but ensures all fields are populated correctly after migration
        return {
          apiKeys: {
            google: state.apiKeys?.google ?? null,
            replicate: state.apiKeys?.replicate ?? null,
            openai: state.apiKeys?.openai ?? null,
            openrouter: state.apiKeys?.openrouter ?? null,
          },
          // always merge with built-in
          models: mergeWithBuiltInModels(state.models) ?? BUILT_IN_MODELS,
          textModels: mergeWithBuiltInTextModels(state.textModels) ?? BUILT_IN_TEXT_MODELS,
          upscalers: mergeWithBuiltInUpscalers(state.upscalers) ?? BUILT_IN_UPSCALERS,
          styles: mergeWithBuiltInStyles(state.styles) ?? BUILT_IN_STYLES,
          characters: state.characters ?? [],
          desktopNotificationsEnabled: state.desktopNotificationsEnabled ?? false,
          notificationPromptDismissed: state.notificationPromptDismissed ?? false,
          requestedOutputCount: state.requestedOutputCount ?? 0,
          editorContextInjectionEnabled: state.editorContextInjectionEnabled ?? true,
          alwaysImprovePromptEnabled: state.alwaysImprovePromptEnabled ?? false,
          semanticSearchEnabled: state.semanticSearchEnabled ?? false,
        };
      },
    }
  )
);

function pruneMissingModelSelections() {
  const { currentModelSelections } = useGenerationStore.getState();
  const modelIds = new Set(useSettingsStore.getState().models.map((model) => model.id));
  const selections = Object.entries(currentModelSelections);
  const validSelections = selections.filter(([id]) => modelIds.has(id));
  if (validSelections.length !== selections.length) {
    useGenerationStore.setState({ currentModelSelections: Object.fromEntries(validSelections) });
  }
}

useGenerationStore.subscribe((state, previous) => {
  if (state.currentModelSelections !== previous.currentModelSelections) {
    pruneMissingModelSelections();
  }
});

useSettingsStore.subscribe((state, previous) => {
  if (state.models !== previous.models) {
    pruneMissingModelSelections();
  }
});

pruneMissingModelSelections();

// Helper to get enabled models that have API keys
export function getEnabledModels(state: SettingsState): StoredModel[] {
  return state.models.filter((m) => m.enabled && hasProviderAccess(state.apiKeys, m.provider));
}

// Helper to get enabled upscalers (requires Replicate key)
export function getEnabledUpscalers(state: SettingsState): StoredUpscaler[] {
  return state.upscalers.filter((u) => u.enabled && hasProviderAccess(state.apiKeys, "replicate"));
}
