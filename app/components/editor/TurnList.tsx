import { useEffect, useRef, useState } from "react";
import { Check, X } from "lucide-react";
import { useEditorStore } from "~/stores/editorStore";
import { Turn } from "./Turn";
import { useGalleryDerivedIndexes } from "~/hooks/useGalleryDerivedIndexes";

export function TurnList() {
  const turns = useEditorStore((s) => s.turns);
  const sourceUrl = useEditorStore((s) => s.sourceUrl);
  const sourcePrompt = useEditorStore((s) => s.sourcePrompt);
  const selectedItemId = useEditorStore((s) => s.selectedItemId);
  const selectItem = useEditorStore((s) => s.selectItem);
  const analysisResult = useEditorStore((s) => s.analysisResult);
  const setAnalysisResult = useEditorStore((s) => s.setAnalysisResult);

  const scrollRef = useRef<HTMLDivElement>(null);
  const prevTurnCountRef = useRef(turns.length);
  const prevAnalysisRef = useRef(analysisResult);

  // Auto-scroll to bottom when new turns are added
  useEffect(() => {
    if (turns.length > prevTurnCountRef.current && scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
    prevTurnCountRef.current = turns.length;
  }, [turns.length]);

  // Auto-scroll when analysis result appears
  useEffect(() => {
    if (analysisResult && !prevAnalysisRef.current && scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
    prevAnalysisRef.current = analysisResult;
  }, [analysisResult]);

  return (
    <div
      ref={scrollRef}
      className="max-h-full flex-1 overflow-x-hidden overflow-y-auto"
      style={{ scrollPaddingBottom: "var(--editor-input-height, 12rem)" }}
    >
      <div
        className="mx-auto flex flex-col items-center gap-8 px-6 pt-6"
        style={{ paddingBottom: "var(--editor-input-height, 12rem)" }}
      >
        {/* Source image "turn zero" */}
        {sourceUrl && (
          <SourceTurn
            url={sourceUrl}
            prompt={sourcePrompt}
            isSelected={selectedItemId === null}
            onSelect={() => selectItem(null)}
          />
        )}

        {/* Edit turns */}
        {turns.map((turn, index) => (
          <Turn turn={turn} key={turn.id} turnIndex={index} />
        ))}

        {/* Analysis result turn */}
        {analysisResult && (
          <AnalysisTurn result={analysisResult} onDismiss={() => setAnalysisResult(null)} />
        )}
      </div>
    </div>
  );
}

function SourceTurn({
  url,
  prompt,
  isSelected,
  onSelect,
}: {
  url: string;
  prompt: string;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const [isLoaded, setIsLoaded] = useState(false);

  // Get source item from gallery if available
  const sourceGalleryItemId = useEditorStore((s) => s.sourceGalleryItemId);
  const { getItemById } = useGalleryDerivedIndexes();
  const galleryItem = getItemById(sourceGalleryItemId);
  const displayUrl =
    galleryItem && galleryItem.status === "completed" ? galleryItem.originalUrl : url;

  return (
    <div className="animate-fade-in relative flex max-w-4xl flex-col items-center">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-text-muted text-xs font-medium tracking-wider uppercase">Source</span>
      </div>

      <button
        type="button"
        onClick={onSelect}
        className={`group relative overflow-hidden rounded-lg transition-all duration-150 ${
          isSelected
            ? "ring-offset-surface ring-2 ring-purple-500 ring-offset-2"
            : "ring-c-border/50 hover:ring-c-border ring-1"
        }`}
      >
        <img
          src={displayUrl}
          alt={prompt || "Source image"}
          className={`max-h-[calc(100dvh-25rem)] max-w-full transition-opacity duration-300 ${isLoaded ? "opacity-100" : "opacity-0"}`}
          onLoad={() => setIsLoaded(true)}
        />

        {!isLoaded && (
          <div
            className="bg-surface-overlay absolute inset-0 animate-pulse"
            style={{ minHeight: "200px" }}
          />
        )}

        {isSelected && (
          <div className="absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded-full bg-purple-500">
            <svg className="h-3 w-3 text-white" viewBox="0 0 12 12" fill="none">
              <path
                d="M2 6l3 3 5-5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        )}

        {!isSelected && (
          <div className="absolute inset-0 bg-white/0 transition-colors group-hover:bg-white/5" />
        )}

        {prompt && (
          <div className="absolute right-0 bottom-0 left-0 bg-linear-to-t from-black/70 to-transparent p-2">
            <p className="line-clamp-2 text-xs leading-snug text-white/80">{prompt}</p>
          </div>
        )}
      </button>
    </div>
  );
}

function AnalysisTurn({ result, onDismiss }: { result: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(result);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="animate-fade-in">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-accent-muted text-xs font-medium tracking-wider uppercase">
          Image Analysis
        </p>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className={`flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors ${
              copied
                ? "text-purple-300"
                : "text-accent-muted hover:bg-purple-500/10 hover:text-purple-300"
            }`}
          >
            {copied && <Check className="h-3 w-3" />}
            {copied ? "Copied!" : "Copy"}
          </button>
          <button
            onClick={onDismiss}
            className="text-text-muted hover:text-text-tertiary rounded p-1 transition-colors"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <p className="text-text-secondary text-sm leading-relaxed">{result}</p>
    </div>
  );
}
