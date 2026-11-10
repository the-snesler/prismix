import {
  Archive,
  Expand,
  Image,
  KeyRound,
  Layers,
  MessageSquareText,
  Palette,
  Users,
  X,
} from "lucide-react";
import { useLocation } from "react-router";
import { useEffect, useRef, useState } from "react";
import { PromptInput } from "./PromptInput";
import { ModelList } from "./ModelList";
import { UpscalerList } from "./UpscalerList";
import { AspectRatioSection } from "./AspectRatioSection";
import { ResolutionSection } from "./ResolutionSection";
import { ModelOptionsSections } from "./ModelOptionsSections";
import { GenerateButton } from "./GenerateButton";
import { PromptVariationsToggle } from "./PromptVariationsToggle";
import { AvoidPastVariationsToggle } from "./AvoidPastVariationsToggle";
import { CharacterModelItem } from "./CharacterModelItem";
import SVG from "react-inlinesvg";
import drop from "~/drop.svg";
import { useEditorStore } from "~/stores/editorStore";
import { useGenerationStore } from "~/stores/generationStore";
import { useSettingsStore } from "~/stores/settingsStore";
import { hasProviderAccess } from "~/lib/providers";
import { Accordion } from "@base-ui/react/accordion";
import { RecentSessions } from "./RecentSessions";

export const SIDEBAR_POPOVER_ID = "sidebar-popover";

type SidebarKind = "gallery" | "editor" | "characters" | "settings";

const SETTINGS_TOC = [
  { id: "api-keys", label: "API Keys", Icon: KeyRound },
  { id: "image-models", label: "Image models", Icon: Layers },
  { id: "characters", label: "Characters", Icon: Users },
  { id: "styles", label: "Styles", Icon: Palette },
  { id: "text-models", label: "Text models", Icon: MessageSquareText },
  { id: "gallery", label: "Gallery", Icon: Image },
  { id: "editor", label: "Editor", Icon: Expand },
  { id: "data", label: "Data", Icon: Archive },
] as const;

function getSidebarKind(pathname: string): SidebarKind | null {
  if (pathname.startsWith("/app/settings")) return "settings";
  if (pathname.startsWith("/app/editor")) return "editor";
  if (pathname.startsWith("/app/characters")) return "characters";
  if (pathname.startsWith("/app/stats")) return null;
  return "gallery";
}

function CharacterSidebarContent() {
  const models = useSettingsStore((s) => s.models);
  const apiKeys = useSettingsStore((s) => s.apiKeys);
  const modelSelections = useGenerationStore((s) => s.currentModelSelections);
  const setModelCount = useGenerationStore((s) => s.setModelCount);

  const visibleModels = models.filter((m) => m.enabled && hasProviderAccess(apiKeys, m.provider));

  useEffect(() => {
    if (visibleModels.length === 0) return;
    const alreadySelected = visibleModels.find((m) => (modelSelections[m.id] ?? 0) > 0);
    const toSelect = alreadySelected ?? visibleModels[0];
    visibleModels.forEach((m) => setModelCount(m.id, m.id === toSelect.id ? 1 : 0));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedId = visibleModels.find((m) => (modelSelections[m.id] ?? 0) > 0)?.id ?? null;

  const handleSelect = (modelId: string) => {
    visibleModels.forEach((m) => setModelCount(m.id, m.id === modelId ? 1 : 0));
  };

  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
      <div className="space-y-2">
        <p className="text-text-tertiary mb-3 px-1 text-xs font-medium tracking-wide uppercase">
          Image model
        </p>
        {visibleModels.length === 0 ? (
          <p className="text-text-muted py-4 text-center text-xs">
            No models available. Add API keys and enable models in Settings.
          </p>
        ) : (
          visibleModels.map((model) => (
            <CharacterModelItem
              key={model.id}
              model={model}
              isSelected={model.id === selectedId}
              onSelect={() => handleSelect(model.id)}
            />
          ))
        )}
      </div>
      <ResolutionSection />
    </div>
  );
}

function SidebarContent({ kind }: { kind: SidebarKind }) {
  if (kind === "settings") {
    return <SettingsSidebarContent />;
  } else if (kind === "editor") {
    return <EditorSidebarContent />;
  } else if (kind === "characters") {
    return <CharacterSidebarContent />;
  } else {
    return <GallerySidebarContent />;
  }
}

function GallerySidebarContent() {
  return (
    <>
      <div className="flex-1 space-y-6 overflow-x-hidden overflow-y-auto px-3 py-4 [scrollbar-gutter:stable_both-edges]">
        <PromptInput />
        <PromptVariationsToggle />
        <AvoidPastVariationsToggle />
        <Accordion.Root defaultValue={["models"]}>
          <ModelList />
        </Accordion.Root>
        <AspectRatioSection />
        <ResolutionSection />
        <ModelOptionsSections />
      </div>
      <div className="border-border-subtle border-t p-4">
        <GenerateButton />
      </div>
    </>
  );
}

function EditorSidebarContent() {
  // Models and Upscale Models share an accordion group: only one open at a time.
  const [openPanels, setOpenPanels] = useState<string[]>(["models"]);
  const [highlightUpscalers, setHighlightUpscalers] = useState(false);
  const pendingFocusedPanel = useEditorStore((s) => s.pendingFocusedPanel);
  const setPendingFocusedPanel = useEditorStore((s) => s.setPendingFocusedPanel);

  useEffect(() => {
    if (pendingFocusedPanel !== "upscalers") return;
    setOpenPanels(["upscalers"]);
    setHighlightUpscalers(true);
    setPendingFocusedPanel(null);
    const timer = setTimeout(() => setHighlightUpscalers(false), 1500);
    return () => clearTimeout(timer);
  }, [pendingFocusedPanel, setPendingFocusedPanel]);

  return (
    <div className="flex-1 space-y-6 overflow-y-auto px-3 py-4 [scrollbar-gutter:stable_both-edges]">
      <RecentSessions />
      <Accordion.Root
        multiple={false}
        value={openPanels}
        onValueChange={(value) => setOpenPanels(value as string[])}
        className="space-y-6"
      >
        <ModelList />
        <UpscalerList highlight={highlightUpscalers} />
      </Accordion.Root>
      <AspectRatioSection />
      <ResolutionSection />
      <ModelOptionsSections editing />
    </div>
  );
}

function SettingsSidebarContent() {
  const [activeId, setActiveId] = useState<string>(SETTINGS_TOC[0].id);
  const intersectingRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const scrollRoot = document.getElementById("settings-scroll");
    const sectionIds = SETTINGS_TOC.map((s) => s.id);

    const updateActive = () => {
      const first = sectionIds.find((id) => intersectingRef.current.has(id));
      if (first) setActiveId(first);
    };

    const observers = sectionIds.map((id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const obs = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) intersectingRef.current.add(id);
          else intersectingRef.current.delete(id);
          updateActive();
        },
        { root: scrollRoot, rootMargin: "0px 0px -60% 0px", threshold: 0 }
      );
      obs.observe(el);
      return obs;
    });

    return () => observers.forEach((o) => o?.disconnect());
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <nav className="flex flex-1 flex-col justify-start gap-0.5 px-3 py-4">
      {SETTINGS_TOC.map(({ id, label, Icon }) => (
        <button
          key={id}
          onClick={() => scrollTo(id)}
          className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${
            activeId === id
              ? "bg-surface-overlay text-text-primary"
              : "text-text-secondary hover:bg-surface-overlay"
          }`}
        >
          <Icon
            className={`h-4 w-4 shrink-0 ${activeId === id ? "text-accent" : "text-text-muted"}`}
          />
          {label}
        </button>
      ))}
    </nav>
  );
}

function SidebarHeader({ onClose }: { onClose?: () => void }) {
  return (
    <div className="border-border-subtle from-accent to-surface-raised flex h-18 items-center justify-between border-b bg-linear-to-br px-6 py-4">
      <div className="flex items-center gap-3">
        <div className="border-accent bg-accent-muted/50 flex h-8 w-8 items-center justify-center rounded-lg border">
          <SVG src={drop} className="h-4 w-4 text-white" />
        </div>
        <div className="text-left">
          <h1 className="text-sm font-semibold">Prismix</h1>
          <p className="text-text-tertiary text-xs">AI Image Generator</p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        {onClose && (
          <button
            onClick={onClose}
            className="hover:bg-surface-overlay rounded-lg p-2 transition-colors md:hidden"
            aria-label="Close sidebar"
          >
            <X className="text-text-tertiary h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

export function Sidebar() {
  const location = useLocation();
  const kind = getSidebarKind(location.pathname);

  if (!kind) return null;

  return (
    <aside className="border-c-border/60 bg-surface-raised/85 fixed top-[calc(4.5rem+1rem)] bottom-4 left-4 z-30 hidden w-80 flex-col overflow-hidden rounded-xl border shadow-2xl backdrop-blur-xl md:flex">
      <SidebarContent kind={kind} />
    </aside>
  );
}

export function MobileSidebar() {
  const location = useLocation();
  const kind = getSidebarKind(location.pathname);

  if (!kind) return null;

  const handleClose = () => {
    const popover = document.getElementById(SIDEBAR_POPOVER_ID);
    popover?.hidePopover();
  };

  return (
    <aside
      id={SIDEBAR_POPOVER_ID}
      popover="auto"
      className="sidebar-popover border-border-subtle bg-surface-raised m-0 flex h-full max-h-full w-80 max-w-[85vw] flex-col border-0 border-r p-0"
    >
      <SidebarHeader onClose={handleClose} />
      <SidebarContent kind={kind} />
    </aside>
  );
}
