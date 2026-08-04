import { Box, Collapse, Paper, ScrollArea } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";
import React from "react";
import SceneTreeTable from "./ControlPanel/SceneTreeTable";

/** Floating, collapsible scene tree panel for offline playback (`.viser` file
 * playback and embedded scenes). The regular control panel only exists with a
 * websocket connection, so this is what makes the scene tree table -- local
 * visibility overrides and property editing -- accessible offline.
 *
 * Two entry points (see PlaybackInterface): animated playback mounts this only
 * when toggled on from the playback bar's scene tree button (already an
 * explicit ask, so it opens expanded); static scenes have no playback bar to
 * hold a button, so the panel is always mounted there and this collapsed
 * header is the affordance. */
export function PlaybackScenePanel({
  defaultExpanded = false,
}: {
  defaultExpanded?: boolean;
}) {
  const [expanded, { toggle }] = useDisclosure(defaultExpanded);
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
        onClick={toggle}
        role="button"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} scene tree`}
        tabIndex={0}
        onKeyDown={(ev) => {
          if (ev.key === "Enter" || ev.key === " ") {
            ev.preventDefault();
            toggle();
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
        {/* Label left + chevron at the right end (rotating down when
        expanded), matching the mobile panel sections -- a leading caret here
        would sit at the same visual level as the tree rows' expand carets
        below, making the header read as just another row. */}
        <Box style={{ flexGrow: 1 }}>Scene tree</Box>
        <IconChevronRight
          size="1em"
          aria-hidden
          style={{
            opacity: 0.55,
            flexShrink: 0,
            transform: expanded ? "rotate(90deg)" : "none",
            transition: "transform 160ms",
          }}
        />
      </Box>
      <Collapse in={expanded}>
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
      </Collapse>
    </Paper>
  );
}
