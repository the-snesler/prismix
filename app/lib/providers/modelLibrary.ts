import { distance } from "fastest-levenshtein";
import type {
  ModelCapabilities,
  ModelPricing,
  Provider as ProviderId,
  SchemaMapping,
} from "~/types";
import type { ResolvedImageModel, SearchResult } from "./types";

export interface ImageModelDefinition<Config = unknown> {
  id: string;
  provider: ProviderId;
  name: string;
  capabilities: ModelCapabilities;
  schemaMapping?: SchemaMapping;
  icon?: string;
  config?: Config;
  pricing?: ModelPricing;
}

export function findLibraryModel<T extends ImageModelDefinition>(
  library: readonly T[],
  modelId: string
): T | undefined {
  const normalizedId = modelId.replace(new RegExp(`^${library[0]?.provider}/`), "").trim();
  return library.find((model) => model.id === normalizedId);
}

export function resolveLibraryModel<T extends ImageModelDefinition>(
  library: readonly T[],
  modelId: string
): ResolvedImageModel | undefined {
  const model = findLibraryModel(library, modelId);
  if (!model) return undefined;

  return {
    name: model.name,
    capabilities: {
      ...model.capabilities,
      ...(model.capabilities.supportedAspectRatios && {
        supportedAspectRatios: [...model.capabilities.supportedAspectRatios],
      }),
      ...(model.capabilities.resolutions && {
        resolutions: [...model.capabilities.resolutions],
      }),
      ...(model.capabilities.supportedQualities && {
        supportedQualities: [...model.capabilities.supportedQualities],
      }),
      ...(model.capabilities.options && {
        options: structuredClone(model.capabilities.options),
      }),
    },
    ...(model.schemaMapping && {
      schemaMapping: {
        ...model.schemaMapping,
        ...(model.schemaMapping.resolution && {
          resolution: { ...model.schemaMapping.resolution },
        }),
        ...(model.schemaMapping.extraDefaults && {
          extraDefaults: { ...model.schemaMapping.extraDefaults },
        }),
      },
    }),
    ...(model.icon && { icon: model.icon }),
  };
}

export function searchModelLibrary<T extends ImageModelDefinition>(
  library: readonly T[],
  query: string,
  limit = 6
): SearchResult[] {
  const q = query.trim().toLowerCase();

  return library
    .filter(
      (model) => !q || model.id.toLowerCase().includes(q) || model.name.toLowerCase().includes(q)
    )
    .map((model) => {
      const id = model.id.toLowerCase();
      const name = model.name.toLowerCase();
      return { model, score: Math.min(distance(q, id), distance(q, name)) };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ model }) => ({
      id: model.id,
      name: model.name,
      icon: model.icon,
    }));
}

export function mergeSearchResults(
  preferred: SearchResult[],
  discovered: SearchResult[],
  limit = 6
): SearchResult[] {
  const byId = new Map<string, SearchResult>();
  for (const result of [...preferred, ...discovered]) {
    if (!byId.has(result.id)) byId.set(result.id, result);
  }
  return [...byId.values()].slice(0, limit);
}
