// Shared drag-handle UI primitives, used across the dock's views: the grip
// pill drawn inside every handle, the hover-highlighted icon button docked in
// handle bars, and the stack handle bar that drags a whole group stack
// (floating multi-group window header / docked column handle).

import { Box } from "@mantine/core";
import {
  IconChevronsLeft,
  IconChevronsRight,
  IconMinus,
  IconPlus,
} from "@tabler/icons-react";
import React from "react";
import { focusRing } from "./DockStyles.css";
import { focusDockControl, keyActivate } from "./gestures";
import { HANDLE_BTN_EM } from "./types";

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
          width: `${HANDLE_BTN_EM}em`,
        }),
      }}
    >
      {children}
    </Box>
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
      title={expanded ? "Minimize" : "Expand"}
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
 * while collapsed (P13). NOT drag-through: the host bar's press means
 * drag-the-stack / click-to-collapse, so a press here must stay its own
 * gesture. */
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
      title="Collapse"
      expanded
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
 * and, like the region chevron, is NOT drag-through: a press here stays
 * click-only while the host bar's own motionless click remains its unmarked
 * backing surface. */
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
      title="Collapse"
      expanded
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
 * With `onToggle`, the bar gets a bulk toggle: minimize or expand every
 * child group at once (direction: expand when EVERY cell is minimized, else
 * minimize all). This is the stack's ONE collapse control (D30): stacked
 * cells carry no per-cell `-` (their minimized bars keep the per-cell `+` --
 * expand is never gated), so bulk and per-cell expand stay distinct actions
 * with distinct signifiers (P9).
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
  toggleTitle,
  endControl,
}: {
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  attrs: Record<string, string>;
  /** Derived stack state: true when EVERY child group is minimized. */
  collapsed?: boolean;
  onToggle?: () => void;
  /** The bar sits on a minimized STRIP (~36px wide): there is no room for the
   * centered pill next to the button, so the button alone fills the bar. */
  narrow?: boolean;
  /** Override the toggle's aria-label when the action is NOT expand/minimize
   * ALL panes (the region rail's toggle only clears the region flag). */
  toggleLabel?: string;
  toggleTitle?: string;
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
        height: "1em",
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
          label={
            toggleLabel ?? (collapsed ? "Expand all panes" : "Minimize all panes")
          }
          title={toggleTitle ?? (collapsed ? "Expand all" : "Minimize all")}
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
