import { Layers2 } from "lucide-react";
import { useEffect, useState } from "react";
import { GalleryImageCard } from "~/components/gallery/GalleryImageCard";
import { useLightboxStore } from "~/stores/lightboxStore";
import { useDiffStore } from "~/stores/diffStore";
import { aspectRatiosCompatibleForDiff } from "~/lib/models";
import type { CompletedGalleryItem, GalleryItem, ReferenceImage } from "~/types";

type RelatedThumbnailProps =
  | {
      kind: "gallery-item";
      current: CompletedGalleryItem;
      item: GalleryItem;
    }
  | {
      kind: "external-ref";
      current: CompletedGalleryItem;
      image: ReferenceImage;
    };

export function RelatedThumbnail(props: RelatedThumbnailProps) {
  const { current } = props;
  const openDiff = useDiffStore((s) => s.openDiff);
  const openLightbox = useLightboxStore((s) => s.openLightbox);

  // Determine the child's aspect ratio + blob + label.
  const externalRefUrl = props.kind === "external-ref" ? props.image.url : null;
  const [externalRefAspect, setExternalRefAspect] = useState<number | null>(null);
  useEffect(() => {
    if (!externalRefUrl) {
      setExternalRefAspect(null);
      return;
    }
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setExternalRefAspect(img.naturalWidth / img.naturalHeight);
      }
    };
    img.src = externalRefUrl;
    return () => {
      cancelled = true;
    };
  }, [externalRefUrl]);

  const currentAspect =
    current.width > 0 && current.height > 0 ? current.width / current.height : null;

  let childUrl: string | null = null;
  let childAspect: number | null = null;
  let childLabel: string | undefined;
  let isSelf = false;

  if (props.kind === "gallery-item") {
    if (props.item.status === "completed") {
      childUrl = props.item.originalUrl;
      childAspect =
        props.item.width > 0 && props.item.height > 0 ? props.item.width / props.item.height : null;
      childLabel = props.item.modelName;
    }
    isSelf = props.item.id === current.id;
  } else {
    childUrl = props.image.url;
    childAspect = externalRefAspect;
    childLabel = props.image.name;
  }

  const canDiff =
    !isSelf &&
    childUrl != null &&
    currentAspect != null &&
    childAspect != null &&
    aspectRatiosCompatibleForDiff(currentAspect, childAspect);

  const handleDiffClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!canDiff || !childUrl) return;
    openDiff({
      parentUrl: current.originalUrl,
      childUrl,
      parentLabel: current.modelName,
      childLabel,
    });
  };

  return (
    <div className="group/related relative">
      {props.kind === "gallery-item" ? (
        <GalleryImageCard item={props.item} selectionDisabled />
      ) : (
        <button
          type="button"
          onClick={() => openLightbox({ kind: "reference", image: props.image })}
          className="bg-surface-overlay hover:ring-c-border overflow-hidden rounded-lg transition-all hover:ring-2"
        >
          <img
            src={props.image.url}
            alt={props.image.name}
            className="aspect-square w-full object-cover"
          />
        </button>
      )}

      {canDiff && (
        <button
          type="button"
          onClick={handleDiffClick}
          title="Compare with current image"
          className="absolute top-2 left-2 z-10 flex h-7 w-7 items-center justify-center rounded-md bg-black/60 opacity-0 backdrop-blur-sm transition-opacity duration-150 group-hover/related:opacity-100"
        >
          <Layers2 className="h-4 w-4 text-white/80" />
        </button>
      )}
    </div>
  );
}
