import { Box, Paper, ScrollArea } from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import React from "react";
import SceneTreeTable from "./ControlPanel/SceneTreeTable";

/** Floating scene tree panel for offline playback (`.viser` file playback and
 * embedded scenes). The regular control panel only exists with a websocket
 * connection, so this is what makes the scene tree table -- local visibility
 * overrides and property editing -- accessible offline.
 *
 * Mounted only while open; closing returns to the launcher that opened it
 * (see PlaybackInterface): the playback bar's scene tree toggle for animated
 * recordings, or the floating corner button for static scenes, which have no
 * playback bar to hold a toggle. */
export function PlaybackScenePanel({ onClose }: { onClose: () => void }) {
  return (
    <Paper
      radius="xs"
      shadow="0.1em 0 1em 0 rgba(0,0,0,0.1)"
      data-playback-scene-tree
      style={{
        position: "fixed",
        top: "1em",
        right: "1em",
        width: "17.5em",
        maxWidth: "calc(100% - 2em)",
        zIndex: 1,
        overflow: "hidden",
      }}
    >
      <Box
        onClick={onClose}
        role="button"
        aria-label="Close scene tree"
        tabIndex={0}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            onClose();
          }
        }}
        fz="sm"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5em",
          padding: "0.375em 0.625em",
          fontWeight: 500,
          cursor: "pointer",
          userSelect: "none",
        }}
      >
        <Box style={{ flexGrow: 1 }}>Scene tree</Box>
        <IconX
          size="1em"
          aria-hidden
          style={{ opacity: 0.55, flexShrink: 0 }}
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
