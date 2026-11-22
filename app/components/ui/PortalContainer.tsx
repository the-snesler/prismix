import { createContext, useContext, type RefObject } from "react";

/**
 * Where floating UI (selects, tooltips) should portal to.
 *
 * Popups normally portal to <body>. Inside a `popover` element (the mobile
 * sidebar) that puts them underneath it, because the popover sits in the
 * browser's top layer, which no z-index can beat. Clicks on them also count as
 * outside the popover and light-dismiss it. Components inside such an element
 * read this to portal into it instead. `undefined` means the default (<body>).
 */
export const PortalContainerContext = createContext<RefObject<HTMLElement | null> | undefined>(
  undefined
);

export function usePortalContainer() {
  return useContext(PortalContainerContext);
}
