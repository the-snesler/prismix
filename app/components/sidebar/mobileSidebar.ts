export const SIDEBAR_POPOVER_ID = "sidebar-popover";

/**
 * Hide the mobile sidebar popover if it's open. No-op on desktop, where the
 * popover is never shown.
 *
 * The popover sits in the browser's top layer, so full-screen overlays that
 * portal to <body> (lightbox, reference markup editor) would open underneath
 * it. Call this before opening one from inside the sidebar.
 */
export function closeMobileSidebar() {
  const popover = document.getElementById(SIDEBAR_POPOVER_ID);
  if (popover?.matches(":popover-open")) popover.hidePopover();
}
