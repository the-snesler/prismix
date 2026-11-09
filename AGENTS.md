# AGENTS.md - Claude Code Guide

## Project Overview

**Prismix** is a single-page AI image generation webapp with a BYOK (Bring Your Own Key) model. Users provide their own API keys, generate images with various AI models, and all data stays in their browser.

### Core Principles
- **Client-side only**: No server-side API routes. Direct browser-to-API calls.
- **BYOK**: API keys stored in localStorage, images in IndexedDB. Nothing leaves the browser.
- **Multi-model**: Users can select multiple models and generate images in parallel.

## Tech Stack

- **Package Manager**: pnpm (use `pnpm install`, not npm)
- **Framework**: React Router 7 (SPA mode, `ssr: false`)
- **Styling**: Tailwind CSS 4
- **State**: Zustand (with localStorage persistence for settings)
- **Storage**: IndexedDB (via `idb`) for images and references, localStorage for API keys/settings
- **Icons**: Lucide React
- **AI**: Google GenAI SDK (`@google/genai`), Replicate SDK

## Commit Message Style

- "feat:", "fix:", "docs:", "refactor:", "style:", "perf:", "test:", "chore:" prefixes
- include relevant issue number in commit body for tracking (e.g., "Closes #123")

## Architecture

```
app/
├── routes/
│   ├── home.tsx              # Layout: Sidebar + Lightbox + Notifications
│   ├── gallery.tsx           # Index route: gallery grid
│   ├── timeline.tsx          # Timeline view of gallery
│   ├── stats.tsx             # Stats dashboard (spend, model usage, timing, habits)
│   ├── settings.tsx          # Settings page
│   ├── editor.tsx            # Image editor page (?imageId param)
│   └── characterEdit.tsx     # Character creation/edit (/characters/new, /characters/:id)
├── components/
│   ├── sidebar/              # Left panel: prompt, models, settings
│   ├── gallery/              # Main area: masonry/timeline grid
│   ├── lightbox/             # Full-screen image viewer
│   ├── settings/             # API key management, model toggles
│   ├── editor/               # Iterative image editor
│   ├── character/            # Character creation/edit view
│   ├── stats/                # Stats dashboard charts (Recharts + validated palette in chartTheme.ts)
│   └── ui/                   # Shared primitives (Switch, Tooltip)
├── stores/
│   ├── settingsStore.ts      # API keys, models, styles, characters (persisted)
│   ├── generationStore.ts    # Current generation inputs (prompt, refs, etc.) (not persisted)
│   ├── galleryStore.ts       # Gallery items + selection state (not persisted)
│   ├── editorStore.ts        # Editor session state (not persisted)
│   ├── lightboxStore.ts      # Lightbox open/target state (not persisted)
│   ├── embeddingStatusStore.ts # Embedding queue progress (not persisted)
│   └── diffStore.ts          # Image diff overlay state (not persisted)
├── hooks/
│   ├── useImageGeneration.ts # Gallery generation logic
│   ├── useEditorGeneration.ts# Editor generation logic
│   └── useGenerationTask.ts  # Shared task runner: API call + retry + DB save
├── lib/
│   ├── generation.ts         # Core API calls (Google/Replicate)
│   ├── models.ts             # Capability helpers & ASPECT_RATIOS
│   ├── modelOptions.ts       # Per-model option registry (complexity, output format, GIF frames)
│   ├── builtInModels.ts      # Pre-configured model definitions
│   ├── builtInStyles.ts      # Pre-configured style definitions
│   ├── db.ts                 # IndexedDB operations
│   ├── promptVariations.ts   # {{...}} variation parsing & generation
│   ├── promptPreparation.ts  # Combined improve+variation prompt batch builder
│   ├── styleApplication.ts   # applyPromptAdditions: appends character + style text
│   ├── referencePrecedence.ts# Manual > style > character truncation under model ref limit
│   ├── textModel.ts          # LLM calls for variations/analysis
│   ├── prompts.ts            # System prompt templates
│   ├── imageProcessing.ts    # Thumbnail generation, dimension reading
│   ├── generationSignature.ts# Deduplication hash
│   ├── retry.ts              # Retry with exponential backoff
│   ├── exportImport.ts       # ZIP-based gallery export/import
│   ├── replicateSchema.ts    # Replicate model schema introspection
│   ├── galleryGrouping.ts    # Date-based grouping utility
│   ├── stats.ts              # Slim stat records + aggregation for the stats page
│   ├── util.ts               # blobToBase64, sleep
│   └── logging.ts            # Debug logger
└── types/
    └── index.ts              # TypeScript types
```

## State Management

### Zustand Stores

1. **`settingsStore`** - Persisted to localStorage (`studio-settings`, current version 26)
   - `apiKeys`: `{ google, replicate, openai }` — provider API keys
   - `models: StoredModel[]` — built-in + user-added Replicate models (ordered)
   - `textModels: StoredTextModel[]` — list of LLMs; exactly one has `enabled: true`
   - `upscalers: StoredUpscaler[]` — built-in + custom upscalers
   - `styles: StoredStyle[]` — built-in + custom prompt styles
   - `characters: StoredCharacter[]` — user-defined subjects (no built-ins)
   - `desktopNotificationsEnabled`, `notificationPromptDismissed`
   - `requestedOutputCount` — lifetime image request counter
   - `editorContextInjectionEnabled`, `alwaysImprovePromptEnabled`, `semanticSearchEnabled`

2. **`generationStore`** - Not persisted
   - **Current input state** (for sidebar UI controls):
     - `currentPrompt`, `currentBasePrompt`, `currentModelSelections`
     - `currentAspectRatio`, `currentResolution`, `currentQuality`, `currentNumberOfImages`
     - `currentModelOptions: Record<modelId, ModelOptionValues>` — raw per-model option picks (see Model Options)
     - `currentReferenceImages: ReferenceImage[]`
     - `currentStyleId`, `currentCharacterId` — single-select pickers
     - `variationsEnabled`, `avoidPastVariations`
   - **Generation tracking**: `isGenerating`, `activeGenerationCount`, `activeGenerationSignatures`, `lastSubmittedSignature`
   - `resetDraft()` revokes ref image object URLs and resets to defaults

3. **`galleryStore`** - Not persisted
   - `items: GalleryItem[]` — unified array of pending/generating/completed/failed items
   - `selectedItemIds`, `lastSelectedId` — multi-select state for gallery cards
   - `searchQuery` — semantic/text search filter
   - Pagination: `dbOffset`, `hasMore`, `isLoadingMore`, `totalCount`
   - Image lifecycle: `loadImages`, `loadMoreImages`, `addItem(s)`, `updateItem`, `deleteItem`, `dismissItem`

4. **`editorStore`** - Not persisted
   - `sourceBlob`, `sourceUrl`, `sourcePrompt`, `sourceGalleryItemId`
   - `turns: EditorTurn[]` — conversation history
   - `selectedItemId` — active canvas item (reference for next edit)
   - `instruction` — current edit input
   - `isGenerating`

5. **`lightboxStore`** - Not persisted — `lightboxTarget` (gallery item or reference image), open/close actions.

6. **`embeddingStatusStore`** - Not persisted — counts and progress for the semantic-search embedding queue.

7. **`diffStore`** - Not persisted — image diff overlay state for comparing two gallery items.

### Important Zustand Pattern

**Don't subscribe to store functions, subscribe to state:**

```tsx
// ❌ BAD - function reference never changes, no re-renders
const getSelectedModelIds = useGenerationStore((s) => s.getSelectedModelIds);
const selected = getSelectedModelIds();

// ✅ GOOD - subscribes to actual state, re-renders on change
const modelSelections = useGenerationStore((s) => s.currentModelSelections);
const selected = Object.entries(modelSelections)
  .filter(([, count]) => count > 0)
  .map(([id]) => id);
```

## Model System

Model definitions live in `lib/builtInModels.ts`. `lib/models.ts` contains only capability helpers.

```typescript
interface StoredModel {
  id: string;
  name: string;
  provider: 'google' | 'replicate';
  enabled: boolean;
  isCustom?: boolean;          // User-added via Settings
  schemaFetched?: boolean;     // Replicate schema has been introspected
  schemaMapping?: SchemaMapping; // Translated parameter names for non-standard models
  capabilities: {
    supportsAspectRatios: boolean;
    supportsResolution: boolean;
    resolutions?: Resolution[];
    supportsReferenceImages: boolean;
    maxReferenceImages: number;
  };
  icon?: string;
}
```

### Capability-Based UI

- **Aspect Ratio Picker**: Enabled if ANY selected model has `supportsAspectRatios: true`
- **Resolution Picker**: Shown if ANY selected model has `supportsResolution: true`
- **Reference Images**: Strict intersection of `maxReferenceImages` across selected models

Key helpers in `lib/models.ts`:
- `anyModelSupportsAspectRatio(models, selectedIds)` — Should picker show?
- `anyModelSupportsResolution(models, selectedIds)` — Show resolution picker?
- `getStrictReferenceImageLimit(models, selectedIds)` — Max reference images
- `canAttachReferenceCount(models, selectedIds, count)` — Validate attachment

### Model Options

Settings that only some models accept (e.g. GPT Image 2.6 `complexity`, SVG/GIF output) are **model options**, not new top-level generation fields.

- A model opts in with `capabilities.options[id]`: an enum (`values`) or a range (`min`/`max`/`step`/`default`).
- `lib/modelOptions.ts` → `MODEL_OPTION_DEFINITIONS` owns the label, control (`stepped` slider with a Default stop, `segmented` buttons, `slider`), `affectsCost`, `visibleWhen` (e.g. GIF frame controls only show for GIF), and `unavailableReason` (e.g. SVG/GIF need no references, since those go through the edits endpoint).
- Raw picks live per model in `generationStore.currentModelOptions`. Always run them through `resolveModelOptions` (or `useDraftModelOptions`) before use. Resolved values are what get sent (`GenerationParams.modelOptions`), saved (`modelOptions` on gallery items/records), hashed (signature), and compared for pricing (only options with `affectsCost`).
- The sidebar renders one collapsible section per selected model with options, titled with the model name (`components/sidebar/ModelOptionsSections.tsx`), using the shared controls in `OptionControls.tsx`.
- To add an option: add its ID to `ModelOptionId`, add a definition to the registry, declare it on the models that support it, and send it in the provider.
- `capabilities.supportsMarkupEdits` marks models whose edits endpoint accepts a markup layer. There's no editor UI for it yet.

### Custom Models

Users can add arbitrary Replicate models via Settings. The app:
1. Calls `replicateSchema.ts` to introspect the model's API schema
2. Calls the text model with `SCHEMA_MAPPING_SYSTEM` prompt to generate a `SchemaMapping`
3. Stores the mapping in `settingsStore` so non-standard parameter names are translated correctly

## Styles & Characters

Both are reusable bundles of prompt text + reference image(s) selected via single-select dropdowns in the prompt input. Conceptually:

- **Style** = an aesthetic (e.g. "watercolor"). Single optional reference image. Text supports a `{n}` placeholder that resolves to the style image's position in the final reference list.
- **Character** = a subject (e.g. "Asher"). Multiple reference images. Plain text, no placeholders.

When applied to a generation:

- **Prompt assembly** (`lib/styleApplication.ts` → `applyPromptAdditions`):
  `user prompt → \n\n → character.text → \n\n → style.text` — character text goes first so style modifiers come last and can override tone.
- **Reference image priority** when the model's strict ref limit forces truncation
  (`lib/referencePrecedence.ts` → `computeReferencePrecedence`):
  `manual > style > character`. Manual wins (user explicitly attached); character refs are most expendable. Final order in the API call: manual, then style, then character.
- The Generate button shows a red warning + tooltip when refs will be dropped.

`StoredCharacter` lives in `settingsStore.characters` (no built-ins). Creating/editing happens at `/characters/new` and `/characters/:id` (`components/character/CharacterEditView.tsx`). Deleting a character also deletes its stored reference blobs via `deleteReferenceImagesByIds`.

**Character ID format**: `char-<uuid>` (no slash) — character IDs appear in URL path params, so they must be a single path segment.

## Image Generation Flow

1. User clicks Generate
2. `useImageGeneration.generate()` runs:
   - Parses `{{...}}` variation sections from prompt
   - If `variationsEnabled`: calls text model to generate N alternatives per section, optionally deduplicating against past generations
   - Creates one `GalleryItem` per model × count with `status: 'pending'`
   - Adds all pending items to `galleryStore.items` immediately (loading cards appear)
   - Persists any reference images to IndexedDB
   - Loads character + style ref blobs, applies precedence (manual > style > character) under the strict ref limit, then assembles the final prompt with `applyPromptAdditions`
   - Calls `useGenerationTask.runTasks()` which executes tasks in parallel via `Promise.allSettled`
3. Each item transitions through states in place:
   - `status: 'waiting'` — rate-limit backoff, shows countdown
   - `status: 'generating'` — API call in flight
   - `status: 'completed'` — blob saved, thumbnail generated, stored in IndexedDB
   - `status: 'failed'` — error shown, can retry

### State Transitions

```
pending → generating → completed (saved to IndexedDB)
        ↘ waiting  ↗
                   ↘ failed (ephemeral — dismissed or cleared on reload)
```

Key insight: **Loading cards and image cards are the same item** — just at different stages. When an item completes, it updates in place.

### Retry & Rate Limiting

`lib/retry.ts` wraps `executeGeneration()` with exponential backoff. A `RateLimitError` (HTTP 429) causes the item to enter `status: 'waiting'` with a visible countdown, then automatically retries.

## Image Editor

The editor is at `/editor` (nested inside the home layout so the sidebar stays visible).

### Flow

1. Entry: user clicks "Edit" in lightbox (passes `?imageId`) or drops a file on the editor page
2. Source image is saved to IndexedDB as a reference image (for retry resilience)
3. User writes an instruction in `EditorInputBar` and clicks Send
4. `useEditorGeneration.generateEdit()`:
   - Creates pending items synchronously and calls `onItemsCreated` **before any await**
   - This ensures the turn is registered in `editorStore` before results arrive
   - Saves completed images to gallery (same IndexedDB as main gallery)
5. Each result appears in the turn's image grid in `TurnList`
6. Clicking an image in a turn selects it (purple ring) — it becomes the reference for the next edit
7. The sidebar's model/aspect ratio/resolution controls apply to editor generation too

### Key Files

- `routes/editor.tsx` — loads image by `?imageId`, sets editor source
- `components/editor/EditorView.tsx` — layout: header + TurnList/DropZone + EditorInputBar
- `components/editor/TurnList.tsx` — scrollable conversation history
- `components/editor/Turn.tsx` — one turn: instruction + source thumb + results grid
- `components/editor/EditorInputBar.tsx` — input, paste-to-set-source, analyze (reverse prompt)
- `components/editor/DropZone.tsx` — empty state when no source loaded
- `stores/editorStore.ts` — session state
- `hooks/useEditorGeneration.ts` — generation hook

## Prompt Variations

Users write `{{description: example1, example2}}` in prompts. When Variations is enabled:

1. `promptVariations.ts` parses the `{{...}}` sections
2. `textModel.ts` is called with `VARIATION_SYSTEM` prompt to generate N alternatives per section
3. If `avoidPastVariations` is on, past variation values are collected and sent to the model to avoid
4. `buildVariedPrompts()` assembles N complete prompts from the alternatives
5. The original `{{...}}` template is stored as `basePrompt`; applied values go in `variationReplacements`

## Text Model

A secondary LLM is used for:
- Generating prompt variations (`VARIATION_SYSTEM`)
- Reverse-prompting images back to text (`REVERSE_PROMPT_SYSTEM`)
- Improving user prompts (`IMPROVE_PROMPT_SYSTEM`)
- Mapping Replicate model schemas (`SCHEMA_MAPPING_SYSTEM`)

Configured in Settings as `settingsStore.textModels: StoredTextModel[]` — exactly one entry has `enabled: true` at a time (use `selectTextModel(id)` to switch). Supports Google Gemini (with `ThinkingLevel.LOW`), OpenAI, and Replicate text models.

## CSS Patterns

### Masonry Grid

Uses `masonry-pf` library with CSS column fallback:

```css
.masonry-grid {
  columns: 4 280px;
  column-gap: 16px;
}
.masonry-grid > * {
  break-inside: avoid;
  margin-bottom: 16px;
}
```

### Dark Theme

App is dark-mode only. Key colors:
- `zinc-950` — Background
- `zinc-900` — Elevated surfaces (sidebar, cards)
- `zinc-800` — Interactive elements
- `purple-500` — Accent/selected states
- `red-400` — Errors

## Common Tasks

### Adding a Built-In Model

1. Add to `BUILT_IN_MODELS` array in `lib/builtInModels.ts`
2. Set `provider`, `capabilities`, and default `enabled` state
3. If new provider: add to `ApiKeys` type in `types/index.ts`, `settingsStore`, and implement in `lib/generation.ts`

### Adding a New Generation Setting

If only some models support it, make it a model option instead (see Model Options). For settings that apply across models:

1. Add to `GenerationState` in `stores/generationStore.ts` (e.g., `currentStylePreset`) and a setter action; include in the `DEFAULT_GENERATION_STATE` object so `resetDraft()` clears it
2. Add to `GalleryItem` + `StoredImageRecord` in `types/index.ts` if it should persist on completed items
3. Create UI component in `components/sidebar/`
4. Pass to generation in `useImageGeneration.ts` and `lib/generation.ts`
5. Include in `saveImage()` call in `lib/db.ts` if persisted
6. If it affects dedup, include it in `buildGenerationSignature` (`lib/generationSignature.ts`)

### Adding a Prompt System

Add a new `const X_SYSTEM = ...` to `lib/prompts.ts` and call it via `callTextModel()` from `lib/textModel.ts`.

### Bumping the Settings Persist Version

`settingsStore` uses Zustand's `persist` middleware with a numeric `version`. When you change the persisted shape:
1. Bump `version` (e.g. 18 → 19)
2. Add a `if (version < N) { ... }` block in `migrate` to transform older state if needed
3. Add the new field to the final `return {...}` object with a sensible default
4. Add the new field to `partialize` so it actually gets persisted

## Build-Time Env Vars

- `VITE_DEMO_BACKUP_URL` — optional URL to a ZIP backup. When set, the empty gallery shows a "Load demo gallery" button that fetches the archive and runs it through `importFromZip` (`lib/exportImport.ts`). Unset = button hidden.

## Gotchas

1. **Object URLs**: Created with `URL.createObjectURL()`, must be revoked to prevent memory leaks.
   - Created in: `galleryStore.loadImages()`, `useImageGeneration` on completion, `editorStore.setSource()`
   - Cleaned up in: `deleteItem()`, `dismissItem()`, `editorStore.reset()`

2. **IndexedDB async**: All DB operations are async. Gallery loads on mount via `useEffect` in `home.tsx`. IndexedDB version is currently **4** with three object stores: `images`, `references`, `sessions`. Reference image cleanup: orphaned refs (no remaining gallery item points to them) are deleted in `galleryStore.deleteItem`/`deleteSelectedItems`/`dismissItem`; characters delete their refs on removal via `deleteReferenceImagesByIds`.

3. **SPA mode**: `react-router.config.ts` has `ssr: false`. No server routes, no loaders/actions.

4. **Unified state**: `GalleryItem` is used for pending, generating, waiting, completed, and failed states. Always check `item.status === 'completed'` before accessing output fields (`originalBlob`, `originalUrl`, `thumbnailUrl`, `width`, `height`, `createdAt`). Input fields (`prompt`, `aspectRatio`, etc.) are always present on all statuses.

5. **Editor generation callback order**: `useEditorGeneration` calls `onItemsCreated(itemIds)` synchronously before any `await`. This is intentional — callers must register the turn in `editorStore` before the async generation completes.

6. **Replicate schema mapping**: Non-standard Replicate models use `schemaMapping` to translate parameter names (e.g., `imageInputKey`, `resolution` map). Always pass through `schemaMapping` when calling `generateWithReplicate`.

7. **Reference image limits**: Use the intersection of `maxReferenceImages` across all selected models. `getStrictReferenceImageLimit()` returns this value (`null` = no model accepts refs; `Infinity` = no cap). When refs from multiple sources exceed the limit, `lib/referencePrecedence.ts` truncates with priority `manual > style > character`.

8. **`builtInModels` vs `settingsStore.models`**: `settingsStore` stores the user's model list (built-ins merged with user overrides). Always read models from the store, not directly from `builtInModels.ts`. Use `mergeWithBuiltInModels()` for migrations.

9. **Generation inputs live in `generationStore`, not `galleryStore`**: `currentPrompt`, `currentReferenceImages`, `currentStyleId`, `currentCharacterId`, etc. are all in `generationStore`. `galleryStore` only owns the gallery item list and selection state. New generation parameters belong in `generationStore` and should be added to `DEFAULT_GENERATION_STATE` so `resetDraft()` cleans them up.

10. **Multi-route file IDs**: When two routes share the same file (e.g. `characters/new` and `characters/:id` both render `routes/characterEdit.tsx`), pass `{ id: "..." }` as the third arg to `route()` in `app/routes.ts` — React Router otherwise rejects duplicate route IDs derived from the file path.
