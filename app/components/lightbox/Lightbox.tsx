import { useEffect, useCallback, useState, type ReactNode, type JSX } from "react";
import {
  X,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  Trash2,
  Copy,
  FilePenLine,
  RotateCcw,
  Check,
  CopyPlus,
  ImageUpscale,
  Star,
  User,
  Info,
  Palette,
} from "lucide-react";
import { Select } from "@base-ui/react/select";
import { useLocation, useNavigate } from "react-router";
import { useGalleryStore } from "~/stores/galleryStore";
import { useLightboxStore } from "~/stores/lightboxStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { useEditorStore } from "~/stores/editorStore";
import { RelatedThumbnail } from "./RelatedThumbnail";
import { useLightboxNavigation } from "~/hooks/useLightboxNavigation";
import { useGalleryDerivedIndexes } from "~/hooks/useGalleryDerivedIndexes";
import {
  useReuseGalleryItemSentPrompt,
  useReuseGalleryItemPrompt,
} from "~/hooks/useReuseGalleryItemPrompt";
import { IconButton } from "./IconButton";
import { ScorecardPanel } from "./ScorecardPanel";
import { WideIconButton } from "./WideIconButton";
import {
  findSessionForImage,
  getReferenceImagesByIds,
  loadImageBlob,
  saveReferenceImage,
} from "~/lib/db";
import type {
  CompletedGalleryItem,
  ReferenceImage,
  StoredCharacter,
  StoredEditorSession,
} from "~/types";
import { Accordion } from "@base-ui/react/accordion";
import { logger } from "~/lib/logging";
import { Tooltip } from "../ui/Tooltip";
import { formatRelativeDate, formatUsd, imageFileExtension } from "~/lib/util";

export function Lightbox() {
  const navigate = useNavigate();
  const location = useLocation();
  const closeLightbox = useLightboxStore((s) => s.closeLightbox);
  const deleteItem = useGalleryStore((s) => s.deleteItem);
  const toggleItemFavorite = useGalleryStore((s) => s.toggleItemFavorite);
  const reuseGalleryItemPrompt = useReuseGalleryItemPrompt();
  const reuseGalleryItemSentPrompt = useReuseGalleryItemSentPrompt();
  const { lightboxTarget, galleryImage, referenceImage, showNavigation, navigateLightbox } =
    useLightboxNavigation();

  const { getPromptGroupForItem, getChildItems, getItemById } = useGalleryDerivedIndexes();
  const setEditorSource = useEditorStore((s) => s.setSource);
  const clearForSessionRestore = useEditorStore((s) => s.clearForSessionRestore);
  const setPendingFocusedPanel = useEditorStore((s) => s.setPendingFocusedPanel);

  const [referenceImages, setReferenceImages] = useState<ReferenceImage[]>([]);
  const [linkedSession, setLinkedSession] = useState<StoredEditorSession | null>(null);
  const [copySuccess, setCopySuccess] = useState(false);
  const [copyRawSuccess, setCopyRawSuccess] = useState(false);
  const imageSrc = galleryImage?.originalUrl ?? referenceImage?.url ?? "";
  const thumbnailSrc = galleryImage?.thumbnailUrl ?? imageSrc;
  const replicateKey = useSettingsStore((s) => s.apiKeys.replicate);
  const styles = useSettingsStore((s) => s.styles);
  const usedStyle = styles.find((s) => s.id === galleryImage?.styleId);
  const allCharacters = useSettingsStore((s) => s.characters);
  const updateImageCharacters = useGalleryStore((s) => s.updateImageCharacters);

  useEffect(() => {
    if (!galleryImage || galleryImage.referenceImageIds.length === 0) {
      setReferenceImages([]);
      return;
    }

    let cancelled = false;
    const loaded: string[] = [];

    getReferenceImagesByIds(galleryImage.referenceImageIds).then((images) => {
      if (cancelled) {
        images.forEach((img) => URL.revokeObjectURL(img.url));
        return;
      }
      loaded.push(...images.map((img) => img.url));
      setReferenceImages(images);
    });

    return () => {
      cancelled = true;
      loaded.forEach((url) => URL.revokeObjectURL(url));
      setReferenceImages([]);
    };
  }, [galleryImage?.id, galleryImage?.referenceImageIds.join("|")]);

  // Check whether this image is part of any editor session
  useEffect(() => {
    if (!galleryImage) {
      setLinkedSession(null);
      return;
    }
    let cancelled = false;
    void findSessionForImage(galleryImage.id).then((session) => {
      if (!cancelled) setLinkedSession(session);
    });
    return () => {
      cancelled = true;
    };
  }, [galleryImage?.id]);

  const hasBasePrompt = Boolean(galleryImage?.basePrompt);
  const promptGroup = getPromptGroupForItem(galleryImage);
  const childItems = getChildItems(galleryImage?.id);

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          closeLightbox();
          break;
        case "ArrowLeft":
          if (lightboxTarget?.kind === "gallery") {
            navigateLightbox("prev");
          }
          break;
        case "ArrowRight":
          if (lightboxTarget?.kind === "gallery") {
            navigateLightbox("next");
          }
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [closeLightbox, lightboxTarget, navigateLightbox]);

  const handleDownload = useCallback(() => {
    if (!galleryImage || galleryImage.status !== "completed") return;

    const link = document.createElement("a");
    link.href = galleryImage.originalUrl;
    link.download = `${galleryImage.modelName}-${Date.now()}.${imageFileExtension(galleryImage.originalMimeType)}`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [galleryImage]);

  const handleCopyPrompt = useCallback(() => {
    if (!galleryImage) return;
    navigator.clipboard.writeText(galleryImage.basePrompt ?? galleryImage.prompt);
    setCopySuccess(true);
    setTimeout(() => setCopySuccess(false), 2000);
  }, [galleryImage]);

  const handleCopyRawPrompt = useCallback(() => {
    if (!galleryImage) return;
    navigator.clipboard.writeText(galleryImage.prompt);
    setCopyRawSuccess(true);
    setTimeout(() => setCopyRawSuccess(false), 2000);
  }, [galleryImage]);

  const handleReusePrompt = useCallback(async () => {
    if (!galleryImage) return;
    await reuseGalleryItemPrompt(galleryImage);
    closeLightbox();
  }, [galleryImage, reuseGalleryItemPrompt, closeLightbox]);

  const handleReuseSentPrompt = useCallback(async () => {
    if (!galleryImage) return;
    await reuseGalleryItemSentPrompt(galleryImage);
    closeLightbox();
  }, [galleryImage, reuseGalleryItemSentPrompt, closeLightbox]);

  const goToEditor = useCallback(
    async (focusPanel: "upscalers" | null) => {
      if (!galleryImage || galleryImage.status !== "completed") return;

      // A linked session restores its own source; otherwise the editor needs the original bytes.
      let sourceBlob: Blob | null = null;
      if (!linkedSession) {
        try {
          sourceBlob = await loadImageBlob(galleryImage);
        } catch (error) {
          logger.error("[lightbox] Failed to load image for editor", error);
          return;
        }
      }

      // Set the navigation hint *before* navigation so the editor sidebar reads it on mount.
      setPendingFocusedPanel(focusPanel);

      if (linkedSession) {
        // Restore the existing session: save + clear current in-memory state, set the
        // target session in localStorage, then let EditorView's restore effect handle it.
        localStorage.setItem("editorSessionId", linkedSession.id);
        clearForSessionRestore();
        closeLightbox();
        navigate("/app/editor");
        return;
      }
      if (!sourceBlob) return;

      const refId = crypto.randomUUID();
      try {
        await saveReferenceImage({
          id: refId,
          blob: sourceBlob,
          name: `${galleryImage.modelName} - ${galleryImage.prompt.slice(0, 40)}`,
          sourceGalleryItemId: galleryImage.id,
        });
      } catch {
        // continue without saved reference
      }
      setEditorSource({
        blob: sourceBlob,
        prompt: galleryImage.prompt,
        galleryItemId: galleryImage.id,
        referenceId: refId,
      });
      closeLightbox();
      navigate("/app/editor");
    },
    [
      galleryImage,
      linkedSession,
      clearForSessionRestore,
      setEditorSource,
      setPendingFocusedPanel,
      closeLightbox,
      navigate,
    ]
  );

  const handleSendToEditor = useCallback(() => goToEditor(null), [goToEditor]);
  const handleUpscale = useCallback(() => goToEditor("upscalers"), [goToEditor]);

  const handleDelete = useCallback(async () => {
    if (!galleryImage) return;
    if (confirm("Delete this image?")) {
      await deleteItem(galleryImage.id);
    }
  }, [galleryImage, deleteItem]);

  const handleToggleFavorite = useCallback(() => {
    if (!galleryImage) return;
    void toggleItemFavorite(galleryImage.id);
  }, [galleryImage, toggleItemFavorite]);

  // Clicking the empty letterbox area around the image closes the lightbox, but
  // clicking the visible image pixels does not. Because the <img> uses
  // object-contain, its element box can be larger than the rendered image, so we
  // only swallow the click when it lands inside the actual rendered rectangle.
  const handleImageClick = useCallback((e: React.MouseEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    const { naturalWidth, naturalHeight } = img;
    const rect = img.getBoundingClientRect();
    if (!naturalWidth || !naturalHeight || !rect.width || !rect.height) return;

    const scale = Math.min(rect.width / naturalWidth, rect.height / naturalHeight);
    const renderedWidth = naturalWidth * scale;
    const renderedHeight = naturalHeight * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const onImage =
      x >= offsetX && x <= offsetX + renderedWidth && y >= offsetY && y <= offsetY + renderedHeight;

    // Only block the close when the click is on the actual image pixels;
    // letterbox clicks fall through to the section handler below.
    if (onImage) e.stopPropagation();
  }, []);

  if (!galleryImage && !referenceImage) return null;

  const imageAlt = galleryImage?.prompt ?? referenceImage?.name ?? "Image preview";

  const usageString = galleryImage?.costEstimate
    ? `~${formatUsd(galleryImage.costEstimate.usd)}`
    : galleryImage?.usage
      ? `Cost unavailable`
      : undefined;
  const usageDetail = galleryImage?.costEstimate ? (
    <>
      <p className="text-text-primary text-sm font-medium">
        {formatUsd(galleryImage.costEstimate.usd)} estimated
      </p>
      {galleryImage.costEstimate.breakdown.map((item) => (
        <p key={item.metric} className="text-text-muted">
          {formatMetric(item.metric, item.amount)} · {formatUsd(item.usd)}
        </p>
      ))}
      <p className="text-text-muted pt-1">
        {galleryImage.costEstimate.pricing.source.kind === "models.dev"
          ? "models.dev"
          : "Prismix model library"}{" "}
        · {new Date(galleryImage.costEstimate.pricing.source.fetchedAt).toLocaleDateString()}
      </p>
      <p className="text-text-muted">Actual billing may vary.</p>
    </>
  ) : galleryImage?.usage ? (
    <>
      <p className="text-text-primary">Cost unavailable</p>
      <p className="text-text-muted">{formatUsageSummary(galleryImage.usage?.metrics ?? {})}</p>
    </>
  ) : undefined;

  const topMetadataRow: (string | [string, JSX.Element])[] = [
    galleryImage?.aspectRatio,
    galleryImage?.resolution
      ? [galleryImage?.resolution, `${galleryImage?.width}x${galleryImage?.height}`]
      : undefined,
    galleryImage?.generationTimeMs != null
      ? `${(galleryImage.generationTimeMs / 1000).toFixed(1)}s`
      : undefined,
    usageString ? [usageString, usageDetail] : undefined,
    galleryImage?.embedding ? "Searchable" : undefined,
  ].filter(Boolean) as (string | [string, JSX.Element])[];

  logger.debug("embedding", galleryImage?.embedding);

  return (
    <div data-lightbox className="bg-surface fixed inset-0 z-50 h-dvh overflow-hidden text-white">
      <img
        src={thumbnailSrc}
        alt=""
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-40 blur-3xl saturate-125"
      />

      <button
        type="button"
        aria-label="Close lightbox"
        className="absolute inset-0 cursor-default"
        onClick={closeLightbox}
      />

      <div className="relative z-10 flex h-full min-h-0 flex-col">
        <header className="border-text-secondary/10 text-text-secondary/80 flex min-h-14 shrink-0 items-center gap-2 border-b px-2.5 py-2 sm:px-3">
          {showNavigation && (
            <div className="flex items-center gap-1">
              <IconButton
                icon={<ChevronLeft className="h-4 w-4" />}
                title="Previous image"
                onClick={() => navigateLightbox("prev")}
              />
              <IconButton
                icon={<ChevronRight className="h-4 w-4" />}
                title="Next image"
                onClick={() => navigateLightbox("next")}
              />
            </div>
          )}

          <div className="min-w-0 flex-1 px-1">
            <p className="truncate text-sm font-medium">
              {galleryImage?.modelName ?? referenceImage?.name ?? "Image preview"}
            </p>
          </div>

          {galleryImage && (
            <div className="flex shrink-0 items-center gap-1 overflow-x-auto">
              {location.pathname !== "/app/editor" && (
                <WideIconButton
                  icon={
                    <span className="relative">
                      <FilePenLine className="h-4 w-4" />
                      {linkedSession && (
                        <span className="absolute -top-1 -right-1 h-1.5 w-1.5 rounded-full bg-purple-400" />
                      )}
                    </span>
                  }
                  title="Editor"
                  tooltip={linkedSession ? "Resume editing session" : "Open in editor"}
                  onClick={handleSendToEditor}
                  textBreakpoint="lg"
                />
              )}
              {location.pathname !== "/app/editor" && (
                <WideIconButton
                  icon={<ImageUpscale className="h-4 w-4" />}
                  title="Upscale"
                  tooltip={
                    !replicateKey
                      ? "Upscaling requires a Replicate API key"
                      : "Open in editor with upscalers"
                  }
                  onClick={handleUpscale}
                  disabled={!replicateKey || galleryImage.status !== "completed"}
                  textBreakpoint="lg"
                />
              )}
              <IconButton
                icon={
                  <Star
                    className={`h-4 w-4 ${galleryImage.isFavorite ? "fill-current text-yellow-300" : ""}`}
                  />
                }
                title={galleryImage.isFavorite ? "Unfavorite" : "Favorite"}
                onClick={handleToggleFavorite}
              />
              <IconButton
                icon={<Download className="h-4 w-4" />}
                title="Download"
                onClick={handleDownload}
              />
              <IconButton
                icon={<Trash2 className="h-4 w-4" />}
                title="Delete"
                onClick={handleDelete}
                variant="danger"
              />
            </div>
          )}

          <IconButton icon={<X className="h-4 w-4" />} title="Close" onClick={closeLightbox} />
        </header>

        <main
          className={`min-h-0 flex-1 gap-3 overflow-y-auto px-2 lg:grid lg:overflow-visible lg:px-4 lg:py-4 ${
            galleryImage
              ? "lg:grid-cols-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(0,1fr)_28rem]"
              : "lg:grid-cols-1"
          }`}
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              closeLightbox();
            }
          }}
        >
          <section className="pointer-events-none flex min-h-[52dvh] cursor-default items-center justify-center overflow-hidden lg:min-h-0">
            <img
              data-lightbox-image
              src={imageSrc}
              width={galleryImage?.width}
              height={galleryImage?.height}
              alt={imageAlt}
              onClick={handleImageClick}
              className="pointer-events-auto block h-auto max-h-[70dvh] min-h-0 w-auto max-w-full min-w-0 cursor-auto lg:max-h-full"
            />
          </section>

          {galleryImage && (
            <aside className="border-c-border/60 bg-surface-raised/85 mt-3 flex min-h-0 flex-col overflow-hidden rounded-xl border shadow-2xl backdrop-blur-xl lg:mt-0">
              <div className="border-border-subtle flex shrink-0 items-start justify-between gap-3 border-b p-4">
                <div className="min-w-0">
                  <h2 className="text-text-primary truncate text-base font-semibold">
                    {galleryImage.modelName}
                  </h2>
                  {galleryImage.createdAt && (
                    <Tooltip content={new Date(galleryImage.createdAt).toLocaleString()}>
                      <p className="text-text-muted mt-1 text-xs">
                        {formatRelativeDate(galleryImage.createdAt)}
                      </p>
                    </Tooltip>
                  )}
                </div>
                {galleryImage.isFavorite && (
                  <Star className="h-4 w-4 shrink-0 fill-current text-yellow-300" />
                )}
              </div>

              <div className="flex-1 space-y-3 overflow-y-auto p-4">
                {(topMetadataRow.length > 0 || allCharacters.length > 0 || usedStyle) && (
                  <div className="text-text-muted flex flex-wrap items-center gap-2 text-xs">
                    {topMetadataRow.map((meta, i) => (
                      <MetadataRow content={meta} key={i} />
                    ))}
                    {usedStyle && (
                      <Tooltip content="Style used for this generation">
                        <span className="bg-surface-overlay/60 border-c-border/50 flex items-center gap-1 rounded-lg border px-2 py-1">
                          <Palette className="h-3 w-3 shrink-0" />
                          {usedStyle.name}
                        </span>
                      </Tooltip>
                    )}
                    <CharacterSection
                      key={galleryImage.id}
                      galleryImage={galleryImage}
                      allCharacters={allCharacters}
                      onCharactersChange={(ids) => {
                        void updateImageCharacters(galleryImage.id, ids);
                      }}
                    />
                  </div>
                )}

                <PanelSection title="Prompt">
                  <div className="space-y-2">
                    <div className="bg-surface-overlay/50 border-c-border/50 space-y-2 rounded-lg border p-3">
                      <p className="text-text-secondary text-sm whitespace-pre-wrap">
                        {galleryImage.basePrompt ?? galleryImage.prompt}
                      </p>
                      {hasBasePrompt && (
                        <Accordion.Root className="border-c-border/60 border-t pt-2">
                          <Accordion.Item>
                            <Accordion.Header>
                              <Accordion.Trigger className="group text-text-muted hover:text-text-tertiary inline-flex list-none items-center gap-1 text-xs [&::-webkit-details-marker]:hidden">
                                <span>Show sent prompt</span>
                                <ChevronDown className="text-text-muted group-hover:text-text-tertiary h-4 w-4 -rotate-90 transition-transform duration-200 group-data-panel-open:rotate-0" />
                              </Accordion.Trigger>
                            </Accordion.Header>
                            <Accordion.Panel className="h-(--accordion-panel-height) overflow-hidden transition-[height] data-ending-style:h-0 data-starting-style:h-0">
                              <p className="text-text-tertiary mt-2 text-xs leading-snug whitespace-pre-wrap">
                                {galleryImage.prompt}
                              </p>
                            </Accordion.Panel>
                          </Accordion.Item>
                        </Accordion.Root>
                      )}
                    </div>
                    <div className="flex items-center gap-1">
                      <IconButton
                        icon={
                          copySuccess ? (
                            <Check className="h-4 w-4 text-green-400" />
                          ) : (
                            <Copy className="h-4 w-4" />
                          )
                        }
                        title="Copy Prompt"
                        onClick={handleCopyPrompt}
                      />
                      {hasBasePrompt && (
                        <IconButton
                          icon={
                            copyRawSuccess ? (
                              <Check className="h-4 w-4 text-green-400" />
                            ) : (
                              <CopyPlus className="h-4 w-4" />
                            )
                          }
                          title="Copy sent prompt (actual prompt that was sent to the model)"
                          onClick={handleCopyRawPrompt}
                        />
                      )}
                      <IconButton
                        icon={<RotateCcw className="h-4 w-4" />}
                        title="Re-use original inputs (prompt, characters, style and references)"
                        onClick={handleReusePrompt}
                      />
                      <IconButton
                        icon={
                          <RotateCcw className="h-4 w-4">
                            <path d="M9 12h6M12 9v6" />
                          </RotateCcw>
                        }
                        title="Re-use sent (exact prompt and references, without rewriting)"
                        onClick={handleReuseSentPrompt}
                      />
                    </div>
                  </div>
                </PanelSection>

                {promptGroup.length > 1 && (
                  <PanelSection title="All outputs" subtitle={`(${promptGroup.length})`}>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
                      {promptGroup.map((item) => (
                        <RelatedThumbnail
                          key={item.id}
                          kind="gallery-item"
                          current={galleryImage}
                          item={item}
                        />
                      ))}
                    </div>
                  </PanelSection>
                )}

                {referenceImages.length > 0 && (
                  <PanelSection title="Reference images" subtitle={`(${referenceImages.length})`}>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
                      {referenceImages.map((img) => {
                        const sourceItem = img.sourceGalleryItemId
                          ? getItemById(img.sourceGalleryItemId)
                          : null;
                        return sourceItem ? (
                          <RelatedThumbnail
                            key={img.id}
                            kind="gallery-item"
                            current={galleryImage}
                            item={sourceItem}
                          />
                        ) : (
                          <RelatedThumbnail
                            key={img.id}
                            kind="external-ref"
                            current={galleryImage}
                            image={img}
                          />
                        );
                      })}
                    </div>
                  </PanelSection>
                )}

                {childItems.length > 0 && (
                  <PanelSection title="Children" subtitle={`(${childItems.length})`}>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(8.5rem,1fr))] gap-2">
                      {childItems.map((item) => (
                        <RelatedThumbnail
                          key={item.id}
                          kind="gallery-item"
                          current={galleryImage}
                          item={item}
                        />
                      ))}
                    </div>
                  </PanelSection>
                )}

                <ScorecardPanel image={galleryImage} />
              </div>
            </aside>
          )}
        </main>
      </div>
    </div>
  );
}

function PanelSection({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-text-tertiary text-xs font-medium">
        {title} {subtitle && <span className="text-text-muted text-xs">{subtitle}</span>}
      </h3>
      {children}
    </section>
  );
}

function CharacterSection({
  galleryImage,
  allCharacters,
  onCharactersChange,
}: {
  galleryImage: CompletedGalleryItem;
  allCharacters: StoredCharacter[];
  onCharactersChange: (ids: string[]) => void;
}) {
  const assignedIds = galleryImage.characterIds ?? [];
  const assignedCharacters = assignedIds
    .map((id) => allCharacters.find((c) => c.id === id))
    .filter((c): c is StoredCharacter => c !== undefined);

  if (allCharacters.length === 0) return null;

  return (
    <Select.Root<string, true> multiple value={assignedIds} onValueChange={onCharactersChange}>
      <Select.Trigger
        aria-label="Select characters"
        className="bg-surface-overlay/60 border-c-border/50 hover:text-text-secondary flex max-w-full items-center gap-1 rounded-lg border px-2 py-1 text-xs transition-colors"
      >
        <User className="h-3 w-3 shrink-0" />
        <Select.Value className="truncate">
          {assignedCharacters.length > 0
            ? assignedCharacters.map((character) => character.name).join(", ")
            : "None"}
        </Select.Value>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner sideOffset={6} className="z-60">
          <Select.Popup className="bg-surface-overlay border-c-border animate-in fade-in zoom-in-95 max-h-60 min-w-44 overflow-y-auto rounded-lg border p-1 text-sm shadow-lg">
            {allCharacters.map((character) => (
              <Select.Item
                key={character.id}
                value={character.id}
                className="text-text-secondary data-highlighted:bg-surface-raised flex items-center gap-2 rounded px-2 py-1.5 outline-none"
              >
                <span className="flex h-3 w-3 items-center justify-center">
                  <Select.ItemIndicator>
                    <Check className="h-3 w-3" />
                  </Select.ItemIndicator>
                </span>
                <Select.ItemText>{character.name}</Select.ItemText>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

function MetadataRow({ content }: { content: string | [string, JSX.Element] }) {
  if (Array.isArray(content)) {
    return (
      <Tooltip content={content[1]}>
        <span className="bg-surface-overlay/60 border-c-border/50 flex items-center gap-1 rounded-lg border px-2 py-1">
          {content[0]}
          <Info className="h-3 w-3" />
        </span>
      </Tooltip>
    );
  }
  return (
    <span className="bg-surface-overlay/60 border-c-border/50 rounded-lg border px-2 py-1">
      {content}
    </span>
  );
}

function formatMetric(metric: string, amount: number): string {
  const labels: Record<string, string> = {
    inputTokens: "input tokens",
    outputTokens: "output tokens",
    textInputTokens: "text input tokens",
    imageInputTokens: "image input tokens",
    textOutputTokens: "text output tokens",
    imageOutputTokens: "image output tokens",
    outputImages: "image",
    inputMegapixels: "input MP",
    outputMegapixels: "output MP",
    runtimeSeconds: "runtime seconds",
  };
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 3 })} ${labels[metric] ?? metric}`;
}

function formatUsageSummary(metrics: Record<string, number | undefined>): string {
  if (typeof metrics.runtimeSeconds === "number")
    return `${metrics.runtimeSeconds.toFixed(1)}s provider runtime recorded; no trusted rate was available.`;
  if (typeof metrics.outputMegapixels === "number")
    return `${metrics.outputMegapixels.toFixed(2)} output MP recorded; no trusted rate was available.`;
  return "Provider usage was recorded, but no trusted rate was available.";
}
