// Model types
export type ApiKeyProvider = "google" | "replicate" | "openai" | "openrouter";
export type Provider = ApiKeyProvider | "debug";

export type AspectRatio = string;

export type Resolution = "1K" | "2K" | "4K";

export interface ModelCapabilities {
  supportsAspectRatios: boolean;
  supportedAspectRatios?: string[]; // should use doesModelSupportAspectRatio() from models.ts to check support
  /** Model accepts any aspect ratio string within its own internal constraints (e.g. gpt-image-2). */
  allowsArbitraryAspectRatio?: boolean;
  /** For arbitrary-AR models, the maximum long:short edge ratio (e.g. 3 for gpt-image-2's 3:1 cap). */
  maxLongShortRatio?: number;
  supportsResolution: boolean;
  resolutions?: Resolution[];
  supportsReferenceImages: boolean;
  maxReferenceImages: number;
  supportsQuality?: boolean;
  supportedQualities?: string[];
  supportsNumberOfImages?: boolean;
  maxImagesPerRequest?: number;
  /** Model-specific options, keyed by `ModelOptionId`. See `lib/modelOptions.ts`. */
  options?: ModelOptionSpecs;
  /** Edits endpoint accepts a transparent markup layer over the first image (no UI yet). */
  supportsMarkupEdits?: boolean;
}

export type ModelOptionId = "complexity" | "outputFormat" | "gifFrameCount" | "gifFrameDurationMs";

/** What a given model accepts for an option. Labels and behavior live in the option registry. */
export type ModelOptionSpec =
  | { kind: "enum"; values: string[] }
  | { kind: "range"; min: number; max: number; step: number; default: number };

export type ModelOptionSpecs = Partial<Record<ModelOptionId, ModelOptionSpec>>;

/** Option values for one model. A missing key means the option's default. */
export type ModelOptionValues = Partial<Record<ModelOptionId, string | number>>;

export interface ModelDefinition {
  id: string;
  name: string;
  provider: Provider;
  apiKeyRequired: ApiKeyProvider;
  capabilities: ModelCapabilities;
  defaultAspectRatio: AspectRatio;
  maxImagesPerRequest: number;
  icon?: string;
}

// Model stored in settings (user-configurable)
export interface StoredModel {
  id: string;
  name: string;
  provider: Provider;
  enabled: boolean;
  isCustom?: boolean; // true for user-added models
  schemaFetched?: boolean; // true if capabilities were fetched from Replicate API
  schemaMapping?: SchemaMapping; // parameter translation for non-standard Replicate models
  capabilities: ModelCapabilities;
  icon?: string; // Path to custom icon SVG (e.g., "/icons/google.svg")
}

// Generation types
export interface ReferenceImage {
  id: string;
  blob: Blob;
  url: string; // Object URL for display
  name: string;
  /** Gallery item ID this reference was derived from, if any */
  sourceGalleryItemId?: string;
}

export interface LoadingPreview {
  dataUrl: string;
  width: number;
  height: number;
}

export interface LightboxGalleryTarget {
  kind: "gallery";
  imageId: string;
}

export interface LightboxReferenceTarget {
  kind: "reference";
  image: Pick<ReferenceImage, "id" | "url" | "name">;
}

export type LightboxTarget = LightboxGalleryTarget | LightboxReferenceTarget;

export interface GenerationRequest {
  prompt: string;
  modelSelections: Record<string, number>; // modelId -> count
  aspectRatio: AspectRatio | null;
  resolution: Resolution | null;
  referenceImages: ReferenceImage[];
}

// Unified gallery item that transitions through states
export interface BaseGalleryItem {
  id: string;
  modelId: string;
  modelName: string;
  prompt: string;
  /** Original template prompt (with {{...}} brackets) when variations were applied. Used to group siblings. */
  basePrompt?: string;
  /** Per-section replacements applied to basePrompt to produce prompt. Index aligns with
   *  sections parsed from basePrompt. Undefined for items generated before this field existed
   *  or when variations were not applied. */
  variationReplacements?: string[];
  aspectRatio: AspectRatio | null;
  resolution: Resolution | null;
  quality?: string | null;
  /** Resolved model-specific options sent with the request (see `lib/modelOptions.ts`). */
  modelOptions?: ModelOptionValues;
  referenceImageIds: string[];
  /** Manual inputs, kept separately from the final references for original-input reuse. */
  manualReferenceImageIds?: string[];
  styleId?: string;
  /** IDs of characters (StoredCharacter.id) used in this generation. */
  characterIds?: string[];
  isFavorite?: boolean;
  loadingPreview?: LoadingPreview;
}

export interface PendingGalleryItemFields {
  status: "pending" | "generating" | "waiting";
  pendingPhase?: "writing" | "variating";
  retryCount?: number;
  waitingUntil?: number; // Timestamp when rate limit expires
  retryAfter?: number; // Seconds to wait (for display)
}

export type PendingGalleryItem = BaseGalleryItem & PendingGalleryItemFields;

export interface CompletedGalleryItemFields {
  status: "completed";
  originalBlob: Blob;
  originalUrl: string; // Object URL for full-quality display/download
  thumbnailBlob: Blob;
  thumbnailUrl: string; // Object URL for gallery card display
  width: number;
  height: number;
  createdAt: number;
  generationTimeMs?: number;
  metadata: Record<string, unknown>; // Will include thinking traces for gemini 3 models
  usage?: GenerationUsage;
  costEstimate?: GenerationCostEstimate;
  /** Gallery item IDs of gallery images used as reference sources for this generation */
  parentGalleryItemIds?: string[];
  /** Vision embedding for semantic search. Absence means not yet embedded. */
  embedding?: number[];
  /** Identifier of the model that produced `embedding`; cleared/recomputed if model changes. */
  embeddingModelId?: string;
  scorecard?: ImageScorecard;
}

export type CompletedGalleryItem = BaseGalleryItem & CompletedGalleryItemFields;

export interface FailedGalleryItemFields {
  status: "failed";
  error: string;
  canRetry?: boolean; // Whether this failure can be retried
}

export type FailedGalleryItem = BaseGalleryItem & FailedGalleryItemFields;

export type GalleryItem = PendingGalleryItem | CompletedGalleryItem | FailedGalleryItem;

// Stored version without URL (URLs are created at runtime)
export interface StoredImageRecord {
  id: string;
  originalBlob: Blob;
  thumbnailBlob: Blob;
  prompt: string;
  basePrompt?: string;
  variationReplacements?: string[];
  modelId: string;
  modelName: string;
  aspectRatio: AspectRatio | null;
  resolution: Resolution | null;
  quality?: string | null;
  modelOptions?: ModelOptionValues;
  width: number;
  height: number;
  createdAt: number;
  generationTimeMs?: number;
  referenceImageIds: string[];
  /** Manual inputs, kept separately from the final references for original-input reuse. */
  manualReferenceImageIds?: string[];
  styleId?: string;
  /** IDs of characters (StoredCharacter.id) used in this generation. */
  characterIds?: string[];
  isFavorite?: boolean;
  parentGalleryItemIds?: string[];
  metadata: Record<string, unknown>;
  usage?: GenerationUsage;
  costEstimate?: GenerationCostEstimate;
  embedding?: number[];
  embeddingModelId?: string;
  scorecard?: ImageScorecard;
}

export type UsageMetric =
  | "inputTokens"
  | "outputTokens"
  | "textInputTokens"
  | "imageInputTokens"
  | "textOutputTokens"
  | "imageOutputTokens"
  | "outputImages"
  | "inputMegapixels"
  | "outputMegapixels"
  | "runtimeSeconds";

export interface GenerationUsage {
  metrics: Partial<Record<UsageMetric, number>>;
  allocationDivisor?: number;
}

export interface PricingRule {
  metric: UsageMetric;
  units: number;
  usd: number;
  when?: { resolutions?: Resolution[]; qualities?: string[] };
}

export interface ModelPricing {
  currency: "USD";
  rules: PricingRule[];
  source: { kind: "model-library" | "models.dev"; url: string; fetchedAt: number };
}

export interface GenerationCostEstimate {
  usd: number;
  currency: "USD";
  breakdown: Array<{ metric: UsageMetric; amount: number; usd: number }>;
  pricing: ModelPricing;
  calculatedAt: number;
}

export type ScorecardCriterion =
  | "likeness"
  | "promptAdherence"
  | "aesthetics"
  | "textAccuracy"
  | "speed"
  | "cost";

export type ScorecardScores = Record<ScorecardCriterion, number | null>;

export interface ImageScorecard {
  scores: ScorecardScores;
  updatedAt: number;
}

export interface AttachSelectedItemsResult {
  success: boolean;
  attachedCount: number;
  maxAllowed: number | null;
  reason?: string;
}

// Upscaler types
export interface StoredUpscaler {
  id: string; // synthetic unique id, e.g. "real-esrgan-2x" or "replicate/owner/model"
  name: string; // "Real-ESRGAN 2x"
  replicateId: string; // "nightmareai/real-esrgan" or "owner/model:versionHash"
  scale: number | null;
  scaleParam: string | null;
  enabled: boolean;
  isCustom?: boolean;
  icon?: string;
}

// Text model types
export interface StoredTextModel {
  id: string; // stable unique id, e.g. "google:gemini-3-flash-preview" or "replicate:google/gemini-3-flash"
  name: string;
  provider: ApiKeyProvider;
  modelId: string; // SDK model identifier
  enabled: boolean; // exactly one is true at a time
  isCustom?: boolean;
  icon?: string;
}

// Character types — subject bundle with text + reference images
export interface StoredCharacter {
  id: string; // "character/<uuid>"
  name: string;
  text: string; // appended to prompt before style text
  enabled: boolean;
  referenceImageIds: string[]; // 0..N FKs into IndexedDB references store
  icon?: string;
}

// Style types — appended to prompt at generation time
export interface StoredStyle {
  id: string; // built-in: stable slug; custom: "custom/<uuid>"
  name: string;
  text: string; // appended to prompt; may contain literal "{n}"
  enabled: boolean;
  isCustom?: boolean;
  referenceImageId?: string; // FK into IndexedDB references store
  icon?: string;
}

export interface SchemaMapping {
  resolutionKey?: string;
  resolution?: Record<string, string>;
  aspectRatioKey?: string;
  imageInputKey?: string;
  qualityKey?: string;
  numberOfImagesKey?: string;
  maxReferenceImages?: number;
  extraDefaults?: Record<string, unknown>;
}

// Settings types
export interface ApiKeys {
  google: string | null;
  replicate: string | null;
  openai: string | null;
  openrouter: string | null;
}

// Editor types
export interface EditorTurn {
  id: string;
  instruction: string;
  /** The actual prompt sent to the model, populated when auto-improve modified the
   *  user's instruction. Displayed secondarily via a dropdown. */
  sentInstruction?: string;
  /** Gallery item ID used as reference (null = original source image) */
  sourceItemId: string | null;
  /** Snapshot of reference blob at time of edit */
  sourceBlob: Blob;
  /** references store ID for sourceBlob; populated at submit time for session persistence */
  sourceReferenceId?: string;
  /** Gallery item IDs for all generated results in this turn */
  itemIds: string[];
  createdAt: number;
  /** AI-generated summary of editing lineage intent (style, character, constraints) */
  contextBrief?: string;
}

/** Blob-free version of EditorTurn for IndexedDB persistence */
export interface StoredEditorTurn {
  id: string;
  instruction: string;
  sentInstruction?: string;
  sourceItemId: string | null;
  sourceReferenceId: string;
  itemIds: string[];
  createdAt: number;
  contextBrief?: string;
}

export interface StoredEditorSession {
  id: string;
  sourceGalleryItemId: string | null;
  sourceReferenceId: string | null;
  sourcePrompt: string;
  turns: StoredEditorTurn[];
  selectedItemId: string | null;
  additionalReferenceIds: string[];
  savedAt: number;
}
