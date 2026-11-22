import { Menu } from "lucide-react";
import { useLocation } from "react-router";
import SVG from "react-inlinesvg";
import drop from "~/drop.svg";
import { SIDEBAR_POPOVER_ID } from "./mobileSidebar";

export function MobileHeader() {
  const location = useLocation();
  const showMenu = !location.pathname.startsWith("/app/stats");

  return (
    <header className="border-border-subtle bg-surface-raised flex shrink-0 items-center justify-between border-b px-4 py-3 md:hidden">
      <div className="flex items-center gap-3">
        <div className="border-accent bg-accent-muted/50 flex h-8 w-8 items-center justify-center rounded-lg border">
          <SVG src={drop} className="h-4 w-4 text-white" />
        </div>
        <div>
          <h1 className="text-sm font-semibold">Prismix</h1>
        </div>
      </div>
      {showMenu ? (
        <button
          popoverTarget={SIDEBAR_POPOVER_ID}
          className="hover:bg-surface-overlay rounded-lg p-2 transition-colors"
          aria-label="Open menu"
        >
          <Menu className="text-text-tertiary h-5 w-5" />
        </button>
      ) : (
        <div className="h-9 w-9" />
      )}
    </header>
  );
}
