// Dev-only playground for the docking library. Served by the Vite dev server
// at /dock_test.html; not part of the production bundle (which only inputs
// index.html). Run `vite` and open http://localhost:3000/dock_test.html.

/* eslint-disable react-refresh/only-export-components -- standalone dev entry. */
import "@mantine/core/styles.css";
// Match the live app's base typography (loads the Inter font from index.css) so
// the playground previews fonts/shadows exactly as production does.
import "../index.css";
import { ActionIcon, Box, MantineProvider, Text, Tooltip } from "@mantine/core";
import {
  IconAdjustments,
  IconCloudCheck,
  IconShare,
} from "@tabler/icons-react";
import React from "react";
import ReactDOM from "react-dom/client";
import { theme } from "../AppTheme";
import { DockArea } from "./DockArea";
import { useDock } from "./DockContext";
import { DockManager } from "./DockManager";
import { makeGroup } from "./layoutOps";
import { DockLayout, PanelRegistry, TabGroup } from "./types";

// Mock of the live control panel's title bar (see ControlPanel.tsx's
// ConnectionStatus + ShareButton + the "Configuration & diagnostics" toggle).
// The dock playground has no server, so this is hard-coded to always look
// connected; the action icons are visual-only (they stopPropagation so a click
// doesn't start a panel drag, and do nothing else here).
function ConnectedTitle() {
  const stop = (event: React.PointerEvent | React.MouseEvent) =>
    event.stopPropagation();
  return (
    <Box
      style={{
        display: "flex",
        alignItems: "center",
        width: "100%",
        gap: "0.25em",
      }}
    >
      {/* Connected status: green cloud-check + label, matching the live app. */}
      <IconCloudCheck
        color="#0b0"
        style={{ width: "1.25em", height: "1.25em", flexShrink: 0 }}
      />
      <Box
        style={{ flexGrow: 1, letterSpacing: "-0.5px", paddingLeft: "0.3em" }}
      >
        Connected
      </Box>
      {/* Action icons on the right: share URL + configuration/diagnostics. */}
      <Tooltip zIndex={100} label="Share" withinPortal>
        <ActionIcon
          onPointerDown={stop}
          onClick={stop}
          style={{ transform: "translateY(0.05em)" }}
        >
          <IconShare stroke={2.25} height="1.125em" width="1.125em" />
        </ActionIcon>
      </Tooltip>
      <Tooltip zIndex={100} label="Configuration & diagnostics" withinPortal>
        <ActionIcon
          onPointerDown={stop}
          onClick={stop}
          style={{ transform: "translateY(0.05em)" }}
        >
          <IconAdjustments stroke={1.625} />
        </ActionIcon>
      </Tooltip>
    </Box>
  );
}

// A handful of demo panels with throwaway content.
function demoBody(label: string, lines: number) {
  return (
    <Box>
      {Array.from({ length: lines }, (_, i) => (
        <Text key={i} size="sm" c="dimmed" mb={4}>
          {label} - line {i + 1}
        </Text>
      ))}
    </Box>
  );
}

// Inner panels available to drop into the nested dockable areas.
const panels: PanelRegistry = {
  scene: {
    id: "scene",
    title: "Scene",
    // A normal panel hosting a nested dockable area. Drag any panel (floating or
    // docked) onto the area to add it as a tab; drag an area tab out to float it
    // or merge it with this (the parent) panel.
    render: () => (
      <Box>
        {demoBody("Scene", 3)}
        <Text size="xs" fw={600} mt="sm" mb={4}>
          Nested dockable area (normal panel):
        </Text>
        <DockArea areaId="area-scene" />
      </Box>
    ),
  },
  controls: {
    id: "controls",
    title: "Controls",
    render: () => demoBody("Controls", 12),
  },
  inspector: {
    id: "inspector",
    title: "Inspector",
    render: () => demoBody("Inspector", 6),
  },
  console: {
    id: "console",
    title: "Console",
    render: () => demoBody("Console", 20),
  },
  // The "main" panel: an UNMERGEABLE panel whose header mocks the live control
  // panel's title bar (Connected status + share/diagnostics actions). Its label
  // shows as a full-width header (not a tab), nothing can be merged into it, and
  // it hosts a nested dockable area.
  monitor: {
    id: "monitor",
    title: "Connected",
    titleNode: <ConnectedTitle />,
    unmergeable: true,
    // The whole body is a single full-bleed nested area (no padding, fills the
    // panel) -- there is nothing else in this panel.
    fullBleed: true,
    render: () => <DockArea areaId="area-main" fill />,
  },
  // Inner panels: ordinary panels that happen to start inside nested areas.
  // There is no difference between these and the "standard" panels above.
  layers: { id: "layers", title: "Layers", render: () => demoBody("Layers", 5) },
  props: {
    id: "props",
    title: "Properties",
    render: () => demoBody("Properties", 7),
  },
  history: {
    id: "history",
    title: "History",
    render: () => demoBody("History", 4),
  },
};

// Build the initial layout: a few floating panels, one already-docked panel, and
// two nested dockable areas (each backed by a flat tab group in `groups`).
const dockedGroup: TabGroup = makeGroup(["scene"]);
const floatA: TabGroup = makeGroup(["controls"]);
const floatB: TabGroup = makeGroup(["inspector"]);
const floatC: TabGroup = makeGroup(["console"]);
const floatM: TabGroup = makeGroup(["monitor"]);
// Area-backing groups (flat tabs). Their panels start docked inside the areas.
const areaSceneGroup: TabGroup = makeGroup(["layers"]);
const areaMainGroup: TabGroup = makeGroup(["props", "history"]);

const initialLayout: DockLayout = {
  groups: {
    [dockedGroup.id]: dockedGroup,
    [floatA.id]: floatA,
    [floatB.id]: floatB,
    [floatC.id]: floatC,
    [floatM.id]: floatM,
    [areaSceneGroup.id]: areaSceneGroup,
    [areaMainGroup.id]: areaMainGroup,
  },
  docked: {
    left: { type: "leaf", id: "n-docked", group: dockedGroup.id, weight: 1 },
    right: null,
  },
  floating: [
    { id: "w-a", x: 360, y: 40, width: 280, stack: [floatA.id] },
    { id: "w-b", x: 680, y: 120, width: 260, stack: [floatB.id] },
    { id: "w-c", x: 480, y: 320, width: 300, stack: [floatC.id] },
    { id: "w-m", x: 900, y: 60, width: 300, height: 380, stack: [floatM.id] },
  ],
  areas: {
    "area-scene": { id: "area-scene", group: areaSceneGroup.id },
    "area-main": { id: "area-main", group: areaMainGroup.id },
  },
};

// Test probe (write side, pairing with the onLayoutChange read probe below):
// window.__dockSetLayout(layout) replaces the layout MODEL directly, so e2e
// suites can inject a starting arrangement instead of building it from long
// chains of setup drags. Rendered inside the DockManager subtree so the
// injection goes through useDock().api.apply -> the manager's applyOp, which
// reconciles docked region widths exactly like a real gesture (top-level
// column weights are rewritten to pixel widths; new columns get the default).
// Injected layouts should reference the registered panel ids above and use a
// distinctive prefix (tests use "t-") for node/group/window ids so they never
// collide with freshId-generated ones. Test-only globals stay confined to
// this playground; the library itself exposes nothing on window.
function LayoutInjector() {
  const { api } = useDock();
  React.useEffect(() => {
    const probe = window as unknown as {
      __dockSetLayout?: (layout: DockLayout) => void;
    };
    probe.__dockSetLayout = (layout) => api.apply(() => layout);
    return () => {
      delete probe.__dockSetLayout;
    };
  }, [api]);
  return null;
}

function Playground() {
  // Match the main page: presence of ?darkMode flips to dark.
  const darkMode =
    new URLSearchParams(window.location.search).get("darkMode") !== null;
  return (
    <MantineProvider
      theme={theme}
      forceColorScheme={darkMode ? "dark" : "light"}
    >
      <Box style={{ width: "100vw", height: "100vh" }}>
        <DockManager
          initialLayout={initialLayout}
          panels={panels}
          // Test probe: e2e suites read the committed layout model directly
          // (DOM scans miss panels whose host tab is inactive, e.g. tabs inside
          // a nested area when the area's host panel body is hidden).
          onLayoutChange={(l) => {
            (window as unknown as { __dockLayout: unknown }).__dockLayout = l;
          }}
        >
          <LayoutInjector />
          {/* Stand-in for the 3D canvas, matching the Viser background. */}
          <Box
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: darkMode ? "#000" : "#fff",
            }}
          >
            <Text c="dimmed">canvas area</Text>
          </Box>
        </DockManager>
      </Box>
    </MantineProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Playground />
  </React.StrictMode>,
);
