import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { useDiffStore } from "~/stores/diffStore";

export function DiffViewer() {
  const isOpen = useDiffStore((s) => s.isOpen);
  const target = useDiffStore((s) => s.target);
  const closeDiff = useDiffStore((s) => s.closeDiff);

  if (!isOpen || !target) return null;
  return <DiffViewerInner target={target} onClose={closeDiff} />;
}

function DiffViewerInner({
  target,
  onClose,
}: {
  target: NonNullable<ReturnType<typeof useDiffStore.getState>["target"]>;
  onClose: () => void;
}) {
  const { parentUrl, childUrl, parentLabel, childLabel } = target;

  const [aspectRatio, setAspectRatio] = useState<number | null>(null);
  const [position, setPosition] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (cancelled) return;
      if (img.naturalWidth > 0 && img.naturalHeight > 0) {
        setAspectRatio(img.naturalWidth / img.naturalHeight);
      }
    };
    img.src = parentUrl;
    return () => {
      cancelled = true;
    };
  }, [parentUrl]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const updatePositionFromEvent = (clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const next = ((clientX - rect.left) / rect.width) * 100;
    setPosition(Math.max(0, Math.min(100, next)));
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    updatePositionFromEvent(e.clientX);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.buttons === 0) return;
    updatePositionFromEvent(e.clientX);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/90 backdrop-blur-sm" onClick={onClose} />

      {/* Close button */}
      <button
        onClick={onClose}
        className="bg-surface-raised/80 hover:bg-surface-overlay absolute top-4 right-4 z-20 rounded-lg p-2 transition-colors"
      >
        <X className="text-text-secondary h-6 w-6" />
      </button>

      {/* Compare surface */}
      <div
        ref={containerRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        className="animate-fade-in bg-surface-raised relative z-10 max-h-[90vh] max-w-[90vw] cursor-ew-resize touch-none overflow-hidden rounded-xl shadow-2xl select-none"
        style={
          aspectRatio ? { aspectRatio, width: `min(90vw, calc(90vh * ${aspectRatio}))` } : undefined
        }
      >
        {parentUrl && childUrl && (
          <>
            <img
              src={parentUrl}
              alt={parentLabel ?? "Before"}
              draggable={false}
              className="absolute inset-0 h-full w-full object-contain"
            />
            <img
              src={childUrl}
              alt={childLabel ?? "After"}
              draggable={false}
              className="absolute inset-0 h-full w-full object-contain"
              style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
            />

            {/* Divider line */}
            <div
              className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-white/90 shadow-lg"
              style={{ left: `${position}%`, transform: "translateX(-50%)" }}
            />

            {/* Drag handle */}
            <div
              className="pointer-events-none absolute top-1/2 flex h-9 w-9 items-center justify-center rounded-full border-2 border-white/90 bg-black/50 shadow-lg backdrop-blur-sm"
              style={{ left: `${position}%`, transform: "translate(-50%, -50%)" }}
            >
              <svg
                className="h-4 w-4 text-white"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="9 6 3 12 9 18" />
                <polyline points="15 6 21 12 15 18" />
              </svg>
            </div>

            {/* Labels */}
            <div className="pointer-events-none absolute top-3 left-3 rounded bg-black/60 px-2 py-1 text-xs font-medium text-white/90 backdrop-blur-sm">
              {parentLabel ?? "Before"}
            </div>
            <div className="pointer-events-none absolute top-3 right-3 rounded bg-black/60 px-2 py-1 text-xs font-medium text-white/90 backdrop-blur-sm">
              {childLabel ?? "After"}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
