import type { GenerationBackend } from "./generationTypes";
import { localGenerationBackend } from "./localGeneration";
import { isServerBackend } from "./mode";
import { remoteGenerationBackend } from "./remoteGeneration";

export type { GenerationBackend } from "./generationTypes";

// Build-time choice: `VITE_BACKEND=server` runs generations on the self-hosted server.
let current: GenerationBackend = isServerBackend ? remoteGenerationBackend : localGenerationBackend;

export function getGenerationBackend(): GenerationBackend {
  return current;
}

export function setGenerationBackend(backend: GenerationBackend): void {
  current = backend;
}
