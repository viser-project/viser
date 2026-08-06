import { Box, Paper, ScrollArea } from "@mantine/core";
import { IconGripHorizontal } from "@tabler/icons-react";
import React from "react";
import SceneTreeTable from "./ControlPanel/SceneTreeTable";

/** Floating scene tree panel for offline playback (`.viser` file playback and
 * embedded scenes). The regular control panel only exists with a websocket
 * connection, so this is what makes the scene tree table -- local visibility
 * overrides and property editing -- accessible offline.
 *
 * Visibility is owned entirely by the scene tree toggle that opened it (see
 * PlaybackInterface): the playback bar's button for animated recordings, or
 * the floating corner button for static scenes. The panel itself only moves:
 * its title bar is a drag handle. `top` positions the initial anchor so the
 * static-scene launcher button isn't covered. `bottomBoundRef` optionally
 * points at the playback bar so drags can't occlude it. */
export function PlaybackScenePanel({
  top = "1em",
  bottomBoundRef,
}: {
  top?: string;
  bottomBoundRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const paperRef = React.useRef<HTMLDivElement | null>(null);
  // Dragged position in viewport px; null until the first drag, where the
  // panel sits at its default top-right anchor.
  const [dragPos, setDragPos] = React.useState<{
    left: number;
    top: number;
  } | null>(null);
  const [dragging, setDragging] = React.useState(false);
  // Cursor offset from the panel's top-left corner at drag start, so the
  // panel doesn't jump to put its corner under the cursor.
  const dragOffset = React.useRef<{ dx: number; dy: number } | null>(null);

  const clamp = (value: number, lo: number, hi: number) =>
    Math.min(Math.max(value, lo), Math.max(lo, hi));

  return (
    <Paper
      ref={paperRef}
      radius="xs"
      shadow="0.1em 0 1em 0 rgba(0,0,0,0.1)"
      data-playback-scene-tree
      style={{
        position: "fixed",
        ...(dragPos === null
          ? { top, right: "1em" }
          : { top: dragPos.top, left: dragPos.left }),
        width: "17.5em",
        maxWidth: "calc(100% - 2em)",
        zIndex: 1,
        overflow: "hidden",
      }}
    >
      <Box
        onPointerDown={(ev) => {
          const rect = paperRef.current!.getBoundingClientRect();
          dragOffset.current = {
            dx: ev.clientX - rect.left,
            dy: ev.clientY - rect.top,
          };
          setDragging(true);
          ev.currentTarget.setPointerCapture(ev.pointerId);
        }}
        onPointerMove={(ev) => {
          if (dragOffset.current === null) return;
          const rect = paperRef.current!.getBoundingClientRect();
          // The panel may not cover the playback bar: its bottom edge stops
          // at the bar's top. The bar is display:none for static scenes, so
          // only a laid-out (nonzero-height) bar constrains the drag.
          let bottomBound = window.innerHeight;
          const barEl = bottomBoundRef?.current;
          if (barEl != null) {
            const barRect = barEl.getBoundingClientRect();
            if (barRect.height > 0) bottomBound = barRect.top;
          }
          setDragPos({
            left: clamp(
              ev.clientX - dragOffset.current.dx,
              0,
              window.innerWidth - rect.width,
            ),
            top: clamp(
              ev.clientY - dragOffset.current.dy,
              0,
              bottomBound - rect.height,
            ),
          });
        }}
        onPointerUp={() => {
          dragOffset.current = null;
          setDragging(false);
        }}
        onPointerCancel={() => {
          dragOffset.current = null;
          setDragging(false);
        }}
        fz="sm"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5em",
          padding: "0.375em 0.625em",
          fontWeight: 500,
          cursor: dragging ? "grabbing" : "grab",
          userSelect: "none",
          // Opt out of native touch scrolling/zoom so touch drags move the
          // panel instead of firing pointercancel mid-drag.
          touchAction: "none",
        }}
      >
        <Box style={{ flexGrow: 1 }}>Scene tree</Box>
        <IconGripHorizontal
          size="1em"
          aria-hidden
          style={{ opacity: 0.4, flexShrink: 0 }}
        />
      </Box>
      {/* Bounded height with the panel's own scrollbars: unlike the control
      panel's dock chrome, there is no surrounding panel body to scroll for
      us during playback. Leave room for the playback bar at the bottom. */}
      <ScrollArea.Autosize
        mah="max(10em, calc(100vh - 8em))"
        scrollbarSize={6}
        type="auto"
        style={{
          borderTop: "1px solid var(--mantine-color-default-border)",
        }}
      >
        <SceneTreeTable />
      </ScrollArea.Autosize>
    </Paper>
  );
}
