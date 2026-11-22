import {
  LayoutDashboard,
  GalleryVertical,
  Settings,
  FilePenLine,
  ArrowLeft,
  BarChart3,
} from "lucide-react";
import NumberFlow from "@number-flow/react";
import SVG from "react-inlinesvg";
import { useLocation, useNavigate } from "react-router";
import { SearchBar } from "./SearchBar";
import { CharacterFilterDropdown } from "./CharacterFilterDropdown";
import { Tooltip } from "../ui/Tooltip";
import drop from "~/drop.svg";

interface GalleryHeaderProps {
  count?: number;
  title?: string;
  searchQuery?: string;
  onSearchChange?: (query: string) => void;
  showFavoritesOnly?: boolean;
  onToggleFavorites?: () => void;
  characterFilter?: string | null;
  onCharacterFilterChange?: (id: string | null) => void;
  showBackButton?: boolean;
}

export function GalleryHeader({
  count = 0,
  title,
  searchQuery,
  onSearchChange,
  showFavoritesOnly = false,
  onToggleFavorites,
  characterFilter,
  onCharacterFilterChange,
  showBackButton = false,
}: GalleryHeaderProps) {
  const location = useLocation();
  const navigate = useNavigate();

  const handleBack = () => navigate(-1);
  const openGallery = () => navigate("/app");
  const openTimeline = () => navigate("/app/timeline");
  const openStats = () => navigate("/app/stats");
  const openSettings = () => navigate("/app/settings");
  const openEditor = () => navigate("/app/editor");

  return (
    <header className="border-border-subtle flex flex-wrap items-center gap-x-2 gap-y-3 border-b px-4 py-3 md:h-18 md:flex-nowrap md:px-6 md:py-4">
      <div className="hidden w-80 shrink-0 items-center gap-3 md:flex">
        <div className="border-accent bg-accent-muted/50 flex h-8 w-8 items-center justify-center rounded-lg border">
          <SVG src={drop} className="h-4 w-4 text-white" />
        </div>
        <div className="text-left">
          <h1 className="text-sm font-semibold">Prismix</h1>
        </div>
      </div>

      <h2 className="text-text-tertiary flex min-w-0 flex-1 items-center gap-2 text-sm font-medium tracking-wide uppercase md:flex-none">
        {showBackButton && (
          <button
            onClick={handleBack}
            aria-label="Back"
            className="text-text-muted hover:text-text-secondary transition-colors"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        {title ? (
          <span className="truncate">{title}</span>
        ) : (
          <span className="truncate">
            <NumberFlow
              value={count}
              format={{ useGrouping: false }}
              transformTiming={{ duration: 300, easing: "ease-out" }}
              spinTiming={{ duration: 300, easing: "ease-out" }}
              opacityTiming={{ duration: 150, easing: "ease-out" }}
              willChange
            />{" "}
            Generation{count !== 1 ? "s" : ""}
          </span>
        )}
      </h2>

      {onSearchChange ? (
        <div className="order-last flex basis-full items-center gap-2 md:order-none md:flex-1 md:basis-auto md:px-4">
          <div className="mx-auto flex w-full items-center gap-2 md:max-w-sm">
            <div className="flex-1">
              <SearchBar
                value={searchQuery ?? ""}
                onChange={onSearchChange}
                showFavoritesOnly={showFavoritesOnly}
                onToggleFavorites={onToggleFavorites}
              />
            </div>
            {onCharacterFilterChange && (
              <CharacterFilterDropdown
                value={characterFilter ?? null}
                onChange={onCharacterFilterChange}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="hidden flex-1 md:block" />
      )}

      <div className="flex shrink-0 items-center gap-1">
        <div className="bg-surface-raised flex items-center gap-1 rounded-lg p-1">
          <ViewModeButton
            onClick={openGallery}
            isActive={location.pathname === "/app"}
            icon={<LayoutDashboard className="h-4 w-4" />}
            label="Gallery"
          />
          <ViewModeButton
            onClick={openTimeline}
            isActive={location.pathname === "/app/timeline"}
            icon={<GalleryVertical className="h-4 w-4" />}
            label="Timeline"
          />
        </div>
        <ViewModeButton
          onClick={openEditor}
          isActive={location.pathname === "/app/editor"}
          icon={<FilePenLine className="h-4 w-4" />}
          label="Editor"
        />
        <ViewModeButton
          onClick={openStats}
          isActive={location.pathname === "/app/stats"}
          icon={<BarChart3 className="h-4 w-4" />}
          label="Stats"
        />
        <ViewModeButton
          onClick={openSettings}
          isActive={location.pathname === "/app/settings"}
          icon={<Settings className="h-4 w-4" />}
          label="Settings"
        />
      </div>
    </header>
  );
}

function ViewModeButton({
  onClick,
  isActive,
  icon,
  label,
}: {
  onClick: () => void;
  isActive: boolean;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <Tooltip content={label} placement="bottom" delay={200}>
      <button
        onClick={onClick}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium transition-colors md:px-3 ${
          isActive
            ? "bg-surface-overlay text-text-primary"
            : "text-text-tertiary hover:bg-surface-overlay hover:text-text-secondary"
        }`}
        aria-label={label}
      >
        {icon}
      </button>
    </Tooltip>
  );
}
