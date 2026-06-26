// Shared drag-handle UI primitives, used across the dock's views: the grip
// pill drawn inside every handle, the hover-highlighted icon button docked in
// handle bars, and the stack handle bar that drags a whole group stack
// (floating multi-group window header / docked column handle).

import { Box } from "@mantine/core";
import { IconMinus, IconPlus } from "@tabler/icons-react";
import React from "react";
import { focusRing } from "./DockStyles.css";
import { keyActivate } from "./gestures";

/** Centered grip line drawn inside every drag handle (grip bars, stack
 * handles, the vertical minimized strip). */
export function GripPill({
  width = "2.5em",
  opacity = 0.5,
}: {
  width?: string;
  opacity?: number;
}) {
  return (
    <Box
      style={{
        width,
        height: "0.2em",
        borderRadius: "0.1em",
        backgroundColor: "var(--mantine-color-dimmed)",
        opacity,
      }}
    />
  );
}

/** Hover-highlighted icon button used inside handles (per-group minimize on
 * the grip bar, minimize-all on a stack handle, expand on a vertical strip
 * cell). `placement` overrides the default right-edge absolute anchoring.
 *
 * Two pointer modes:
 * - Default: swallows pointerdown so pressing the button can't arm the
 *   handle's drag gesture; a click activates directly.
 * - `dragThrough`: the press FLOWS to the parent handle, whose click-vs-drag
 *   arbitration decides -- motion drags the panel, a motionless release
 *   activates (the parent passes the activation as its onClick). The button
 *   itself only activates on synthetic clicks (element.click() from tests /
 *   assistive tech, event.detail === 0); real pointer clicks are the
 *   parent's, so the toggle can't fire twice. */
export function HandleIconButton({
  label,
  title,
  expanded,
  onActivate,
  attrs,
  placement,
  dragThrough = false,
  children,
}: {
  label: string;
  title: string;
  expanded: boolean;
  onActivate: () => void;
  attrs: Record<string, string>;
  placement?: React.CSSProperties;
  dragThrough?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = React.useState(false);
  return (
    <Box
      {...attrs}
      role="button"
      tabIndex={0}
      className={focusRing}
      aria-label={label}
      aria-expanded={expanded}
      title={title}
      onKeyDown={keyActivate(onActivate)}
      onPointerDown={
        dragThrough ? undefined : (event) => event.stopPropagation()
      }
      onClick={(event) => {
        if (dragThrough && event.detail !== 0) return;
        event.stopPropagation();
        onActivate();
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        cursor: "pointer",
        color: hover
          ? "var(--mantine-primary-color-filled)"
          : "var(--mantine-color-dimmed)",
        backgroundColor: hover
          ? "var(--mantine-primary-color-light)"
          : "transparent",
        transition: "color 80ms ease, background-color 80ms ease",
        ...(placement ?? {
          position: "absolute",
          right: 0,
          top: 0,
          bottom: 0,
          width: "1.7em",
        }),
      }}
    >
      {children}
    </Box>
  );
}

/** Slim header bar that drags a whole stack of groups: a floating multi-group
 * window or a docked pure column. Body-colored so it reads as the stack's
 * *container*, distinct from the child groups' gray grip bars; the bottom rule
 * keeps it visible against the first child's grip bar.
 *
 * With `onToggle`, the bar gets a minimize-ALL button: it minimizes every
 * child group (tagging the ones that were expanded), and -- when every child
 * is minimized -- expands them back to that remembered mix (see
 * minimizeStack/expandStack in layoutOps).
 *
 * The toggle button is `dragThrough`: a real pointer press flows to the bar's
 * own onPointerDown (the click-vs-drag arbiter), so dragging the + still drags
 * the whole stack out and only a motionless click toggles. Callers must
 * therefore pass `onToggle` as the drag-starter's `onClick` too (the bar's
 * onPointerDown), so the motionless-press toggle fires; `onActivate` here then
 * only handles keyboard / synthetic activation. */
export function StackHandleBar({
  onPointerDown,
  attrs,
  collapsed = false,
  onToggle,
  narrow = false,
}: {
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  attrs: Record<string, string>;
  /** Derived stack state: true when EVERY child group is minimized. */
  collapsed?: boolean;
  onToggle?: () => void;
  /** The bar sits on a minimized STRIP (~36px wide): there is no room for the
   * centered pill next to the button, so the button alone fills the bar. */
  narrow?: boolean;
}) {
  return (
    <Box
      {...attrs}
      onPointerDown={onPointerDown}
      style={{
        position: "relative",
        flexShrink: 0,
        height: "1em",
        cursor: "grab",
        backgroundColor: "var(--mantine-color-body)",
        borderBottom: "1px solid var(--mantine-color-default-border)",
        touchAction: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {!narrow && <GripPill width="3em" opacity={0.6} />}
      {onToggle !== undefined && (
        <HandleIconButton
          attrs={{ "data-dock-minimize-all": "true" }}
          label={collapsed ? "Expand all panes" : "Minimize all panes"}
          title={collapsed ? "Expand all" : "Minimize all"}
          expanded={!collapsed}
          onActivate={onToggle}
          // Press flows to the bar's drag gesture (drag = tear out the whole
          // stack; motionless click = toggle, via the drag-starter's onClick).
          dragThrough
          placement={
            narrow
              ? { position: "relative", width: "100%", height: "100%" }
              : undefined
          }
        >
          {collapsed ? <IconPlus size={12} /> : <IconMinus size={12} />}
        </HandleIconButton>
      )}
    </Box>
  );
}
