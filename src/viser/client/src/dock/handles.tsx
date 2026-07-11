// Shared drag-handle UI primitives, used across the dock's views: the grip
// pill drawn inside every handle, the hover-highlighted icon button docked in
// handle bars, and the stack handle bar that drags a whole group stack
// (floating multi-group window header / docked column handle).

import { Box, Tooltip } from "@mantine/core";
import {
  IconChevronsLeft,
  IconChevronsRight,
  IconMinus,
  IconPlus,
} from "@tabler/icons-react";
import React from "react";
import { focusRing } from "./DockStyles.css";
import { focusDockControl, keyActivate } from "./gestures";
import { HANDLE_BTN_EM, STACK_HANDLE_EM } from "./types";

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

/** Square-ish handle-button size (em): HandleIconButton's default width, the
 * ChromeToggle / rail-cap button extent, and the basis other chrome uses to
 * clear these buttons (e.g. the region-collapse chevron's inset). Lives here,
 * with the button it sizes, rather than in types.ts. */

/** Hover-highlighted icon button used inside handles (the single-group
 * floating window's minimize on the grip bar, the window header's toggle,
 * expand on a rail header). `placement` overrides the default right-edge
 * absolute anchoring. Wrapped in a real Tooltip (D35) -- `tooltip` is the
 * short hover text; `label` stays the aria-label.
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
  tooltip,
  expanded,
  onActivate,
  attrs,
  placement,
  dragThrough = false,
  children,
}: {
  label: string;
  tooltip: string;
  expanded: boolean;
  onActivate: () => void;
  attrs: Record<string, string>;
  placement?: React.CSSProperties;
  dragThrough?: boolean;
  children: React.ReactNode;
}) {
  const [hover, setHover] = React.useState(false);
  return (
    <Tooltip label={tooltip} openDelay={300} withinPortal>
    <Box
      {...attrs}
      role="button"
      tabIndex={0}
      className={focusRing}
      aria-label={label}
      aria-expanded={expanded}
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
        // The smallest interactive unit owns the pointer (P12): a floating
        // window's resize grips overlay the window border with an INSIDE
        // bias (edges 5px, corners 11px, z 12/13), which reaches the top
        // sliver of a header's right-end control -- the `-` at the
        // top-right corner showed a resize cursor and armed a resize
        // instead of the click. Chrome controls paint above the grips, so
        // the grip keeps only the pixels the button doesn't claim.
        position: "relative",
        zIndex: 14,
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
          width: `${HANDLE_BTN_EM}em`,
        }),
      }}
    >
      {children}
    </Box>
    </Tooltip>
  );
}

/** Hairline divider between chrome siblings (P10: borders divide, never
 * enclose). `vertical` separates side-by-side segments in a 36px bar (drawn
 * inset so it reads as a separator, not a full-height wall); horizontal
 * separates stacked rail cells. */
export function ChromeDivider({ vertical = false }: { vertical?: boolean }) {
  return (
    <Box
      style={{
        flexShrink: 0,
        backgroundColor: "var(--mantine-color-default-border)",
        opacity: 0.5,
        ...(vertical
          ? { width: 1, alignSelf: "center", height: "60%" }
          : { height: 1 }),
      }}
    />
  );
}

/** The +/- toggle placed at a chrome bar's RIGHT end (P13: where the
 * expanded header's `-` sits; spatially stable across minimize/expand).
 * Thin wrapper over HandleIconButton fixing the shared geometry so every
 * bar's toggle is identical. dragThrough by design: a press flows to the
 * surface's drag handler; the motionless click comes from that handler's
 * onClick, and onActivate covers keyboard/synthetic activation. */
export function ChromeToggle({
  expanded,
  label,
  onActivate,
  compact = false,
}: {
  expanded: boolean;
  label: string;
  onActivate: () => void;
  /** Smaller, quieter form for hosts that carry their own prominent
   * controls (the unmergeable panel header's action icons): the toggle is
   * ONLY a signifier there -- the whole header is the click target -- so it
   * can shrink without costing hit area (P11's backing-surface rule). */
  compact?: boolean;
}) {
  return (
    <HandleIconButton
      attrs={{ "data-dock-minimize": "true" }}
      label={label}
      tooltip={expanded ? "Minimize" : "Expand"}
      expanded={expanded}
      dragThrough
      onActivate={onActivate}
      placement={{
        width: compact ? "1.2em" : `${HANDLE_BTN_EM}em`,
        height: "100%",
        flexShrink: 0,
      }}
    >
      {expanded ? (
        <IconMinus size={compact ? 10 : 12} />
      ) : (
        <IconPlus size={compact ? 10 : 12} />
      )}
    </HandleIconButton>
  );
}

/** Region-collapse chevron (D21/D26), rendered at the right end of the
 * docked region's PARENT HANDLE -- the same spot the rail header's + holds
 * while collapsed (P13). Drag-through like every other right-end control
 * (T6 resolved): a press flows to the host bar's drag arbitration -- motion
 * drags the stack, a motionless click collapses via the bar's own onClick
 * backing (the same action). onActivate covers keyboard and synthetic
 * clicks (element.click(), detail === 0) and keeps the focus handoff. */
export function RegionCollapseChevron({
  edge,
  onActivate,
}: {
  edge: "left" | "right";
  onActivate: () => void;
}) {
  return (
    <HandleIconButton
      attrs={{ "data-dock-region-collapse": edge }}
      label="Collapse panel area"
      tooltip="Collapse"
      expanded
      dragThrough
      onActivate={() => {
        onActivate();
        // A keyboard collapse unmounts the chevron with its chrome row; hand
        // focus to the rail header's toggle (the same-spot undo control)
        // instead of <body> -- spec 4 / edge case 14.
        focusDockControl(
          `[data-dock-region-rail="${edge}"] [data-dock-minimize-all]`,
        );
      }}
      placement={{
        width: `${HANDLE_BTN_EM}em`,
        height: "100%",
        flexShrink: 0,
      }}
    >
      {edge === "right" ? (
        <IconChevronsRight size={13} />
      ) : (
        <IconChevronsLeft size={13} />
      )}
    </HandleIconButton>
  );
}

/** Column-collapse chevron: the per-COLUMN sibling of RegionCollapseChevron,
 * rendered at the right end of a column parent handle whose band has sibling
 * columns (D27). It rails exactly what its handle owns -- that one column --
 * and, like the region chevron, is drag-through (T6 resolved): a press flows
 * to the host bar (drag = float the column; motionless click = rail it, via
 * the bar's onClick backing), while onActivate covers keyboard/synthetic
 * activation and keeps the focus handoff. */
export function ColumnCollapseChevron({
  edge,
  columnId,
  onActivate,
}: {
  edge: "left" | "right";
  columnId: string;
  onActivate: () => void;
}) {
  return (
    <HandleIconButton
      attrs={{ "data-dock-column-collapse": columnId }}
      label="Collapse column"
      tooltip="Collapse"
      expanded
      dragThrough
      onActivate={() => {
        onActivate();
        // A keyboard collapse unmounts the chevron with its handle; hand
        // focus to the column rail's toggle (the same-spot undo control)
        // instead of <body> -- spec 4 / edge case 14.
        focusDockControl(
          `[data-dock-column-rail="${columnId}"] [data-dock-minimize-all]`,
        );
      }}
      placement={{
        width: `${HANDLE_BTN_EM}em`,
        height: "100%",
        flexShrink: 0,
      }}
    >
      {edge === "right" ? (
        <IconChevronsRight size={13} />
      ) : (
        <IconChevronsLeft size={13} />
      )}
    </HandleIconButton>
  );
}

/** Slim header bar that drags a whole stack of groups: a floating multi-group
 * window or a docked pure column. Body-colored so it reads as the stack's
 * *container*, distinct from the child groups' gray grip bars.
 *
 * With `onToggle`, the bar gets the stack's ONE collapse control
 * (D30/D32/D38): it flips the container's single flag -- a floating window's
 * `collapsed`, or a rail header's expand -- so it is plain collapse/expand
 * of the scope, not a bulk "toggle all".
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
  toggleLabel,
  toggleTooltip,
  endControl,
}: {
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  attrs: Record<string, string>;
  /** The container's ONE collapse flag (D38), as rendered state. */
  collapsed?: boolean;
  onToggle?: () => void;
  /** The bar sits on a minimized STRIP (~36px wide): there is no room for the
   * centered pill next to the button, so the button alone fills the bar. */
  narrow?: boolean;
  /** Override the toggle's aria-label when the action is scoped narrower
   * than the window's panels (the rail headers' honest wording). */
  toggleLabel?: string;
  toggleTooltip?: string;
  /** Replace the default +/- toggle with a different right-end control
   * (the docked region parent handle renders the region-collapse chevron
   * there instead, D26). */
  endControl?: React.ReactNode;
}) {
  return (
    <Box
      {...attrs}
      onPointerDown={onPointerDown}
      style={{
        position: "relative",
        flexShrink: 0,
        height: `${STACK_HANDLE_EM}em`,
        cursor: "grab",
        backgroundColor: "var(--mantine-color-body)",
        touchAction: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {!narrow && <GripPill width="3em" opacity={0.6} />}
      {endControl !== undefined && (
        // The slot owns its geometry: end controls ALWAYS sit at the bar's
        // right end, regardless of caller -- position is not a per-call-site
        // decision (two call sites once produced two placements).
        <Box
          style={{
            position: "absolute",
            right: 0,
            top: 0,
            height: "100%",
            display: "flex",
          }}
        >
          {endControl}
        </Box>
      )}
      {endControl === undefined && onToggle !== undefined && (
        <HandleIconButton
          attrs={{ "data-dock-minimize-all": "true" }}
          // One flag per container (D38), so the default action is plain
          // collapse/expand of the window's panels -- no "all" language.
          label={toggleLabel ?? (collapsed ? "Expand panels" : "Minimize panels")}
          tooltip={toggleTooltip ?? (collapsed ? "Expand" : "Minimize")}
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
