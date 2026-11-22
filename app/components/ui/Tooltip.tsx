import { useState, useRef, type ReactNode, type ReactElement, cloneElement } from "react";
import {
  useFloating,
  useHover,
  useInteractions,
  useDismiss,
  useTransitionStyles,
  arrow,
  offset,
  flip,
  shift,
  FloatingPortal,
  FloatingArrow,
  type Placement,
} from "@floating-ui/react";
import { usePortalContainer } from "./PortalContainer";

interface TooltipProps {
  content: ReactNode;
  children: ReactElement<Record<string, unknown>>;
  placement?: Placement;
  delay?: number;
  maxWidth?: string;
}

export function Tooltip({
  content,
  children,
  placement = "bottom",
  delay = 300,
  maxWidth = "max-w-64",
}: TooltipProps) {
  const [open, setOpen] = useState(false);
  const arrowRef = useRef(null);
  const portalContainer = usePortalContainer();
  const { refs, floatingStyles, context, isPositioned } = useFloating({
    open,
    onOpenChange: setOpen,
    placement,
    middleware: [
      offset(8),
      flip(),
      shift({ padding: 8 }),
      arrow({ element: arrowRef, padding: 8 }),
    ],
  });

  const hover = useHover(context, { delay: { open: delay, close: 0 } });
  const dismiss = useDismiss(context);
  const { getReferenceProps, getFloatingProps } = useInteractions([hover, dismiss]);
  const { isMounted, styles: transitionStyles } = useTransitionStyles(context, {
    duration: 150,
    initial: { opacity: 0, transform: "scale(0.96)" },
    open: { opacity: 1, transform: "scale(1)" },
  });

  return (
    <>
      {cloneElement(children, {
        ref: refs.setReference,
        ...getReferenceProps(),
      })}
      {isMounted && (
        <FloatingPortal root={portalContainer}>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            {...getFloatingProps()}
            className="z-50"
          >
            <div
              style={isPositioned ? transitionStyles : { opacity: 0 }}
              className={`${maxWidth} border-c-border bg-surface-overlay text-text-secondary rounded-lg border px-2.5 py-1.5 text-[11px] leading-relaxed shadow-xl`}
            >
              <FloatingArrow
                ref={arrowRef}
                context={context}
                fill="var(--color-surface-overlay)"
                stroke="var(--color-c-border)"
                strokeWidth={0.75}
                tipRadius={1}
                width={12}
                height={6}
              />
              {content}
            </div>
          </div>
        </FloatingPortal>
      )}
    </>
  );
}
