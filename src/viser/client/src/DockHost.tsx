// @refresh reset

import {
  DockviewApi,
  DockviewReact,
  DockviewReadyEvent,
  IDockviewPanelProps,
  Position,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import "./DockHost.css";
import { useMantineColorScheme } from "@mantine/core";
import React from "react";
import { ViewerContext } from "./ViewerContext";
import GeneratedGuiContainer from "./ControlPanel/Generated";
import { GuiPanelMessage } from "./WebsocketMessages";

const CANVAS_PANEL_ID = "viser:canvas";

// Stable context for the canvas JSX so its inner React tree (the WebGL
// <Canvas>) doesn't unmount when Dockview reshuffles panels.
const CanvasNodeContext = React.createContext<React.ReactNode>(null);

function CanvasPanel(_props: IDockviewPanelProps) {
  const node = React.useContext(CanvasNodeContext);
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
      }}
    >
      {node}
    </div>
  );
}

function UserPanel(props: IDockviewPanelProps) {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        overflow: "auto",
        background: "var(--mantine-color-body)",
        color: "var(--mantine-color-text)",
      }}
    >
      <GeneratedGuiContainer containerUuid={props.api.id} />
    </div>
  );
}

const components = {
  canvas: CanvasPanel,
  "user-panel": UserPanel,
};

const DEFAULT_FLOATING_WIDTH = 320;
const DEFAULT_FLOATING_HEIGHT = 400;
const DEFAULT_DOCKED_SIZE = 280;
const CASCADE_X = 16;
const CASCADE_Y_START = 16;
const CASCADE_Y_STEP = 32;

type DockSide = "left" | "right" | "top" | "bottom" | "floating";

function directionFromDock(side: Exclude<DockSide, "floating">): Position {
  return side as Position;
}

/**
 * Dockview host. Wraps the 3D canvas in a single locked Dockview panel and
 * adds server-requested panels (`server.gui.add_panel`) as additional groups
 * docked to the canvas edges or as floating windows.
 *
 * The ControlPanel (FloatingPanel) renders as a separate overlay on top —
 * it is NOT part of Dockview.
 */
export default function DockHost({ canvas }: { canvas: React.ReactNode }) {
  const viewer = React.useContext(ViewerContext)!;
  const { colorScheme } = useMantineColorScheme();

  const rootSet = viewer.useGui(
    (state) => state.guiUuidSetFromContainerUuid["root"] ?? {},
  );
  const orderMap = viewer.useGui((state) => state.guiOrderFromUuid);

  const userPanels = React.useMemo(() => {
    const out: {
      uuid: string;
      title: string;
      order: number;
      dock: DockSide;
    }[] = [];
    for (const uuid of Object.keys(rootSet)) {
      const conf = viewer.useGuiConfig.get(uuid) as GuiPanelMessage | undefined;
      if (!conf || conf.type !== "GuiPanelMessage") continue;
      const dock = (conf.props.dock ?? "floating") as DockSide;
      out.push({
        uuid: conf.uuid,
        title: conf.props.title,
        order: orderMap[uuid] ?? 0,
        dock,
      });
    }
    out.sort((a, b) => a.order - b.order);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootSet, orderMap]);

  const apiRef = React.useRef<DockviewApi | null>(null);
  const mountedUserIdsRef = React.useRef<Set<string>>(new Set());
  // For each docked side, remember the first panel's id so subsequent
  // same-side panels can tab into the same group.
  const dockedGroupAnchorRef = React.useRef<Map<DockSide, string>>(new Map());

  const syncUserPanels = React.useCallback(() => {
    const api = apiRef.current;
    if (!api) return;
    const want = new Set(userPanels.map((p) => p.uuid));

    let floatingIdx = 0;
    mountedUserIdsRef.current.forEach((id) => {
      const p = userPanels.find((q) => q.uuid === id);
      if (p && p.dock === "floating") floatingIdx += 1;
    });

    userPanels.forEach((p) => {
      if (mountedUserIdsRef.current.has(p.uuid)) {
        const panel = api.getPanel(p.uuid);
        if (panel && panel.title !== p.title) panel.setTitle(p.title);
        return;
      }

      if (p.dock === "floating") {
        const cascadeY = CASCADE_Y_START + floatingIdx * CASCADE_Y_STEP;
        floatingIdx += 1;
        const userPanel = api.addPanel({
          id: p.uuid,
          component: "user-panel",
          title: p.title,
          floating: {
            position: { left: CASCADE_X, top: cascadeY },
            width: DEFAULT_FLOATING_WIDTH,
            height: DEFAULT_FLOATING_HEIGHT,
          },
        });
        userPanel.group.api.setConstraints({
          minimumWidth: 200,
          minimumHeight: 120,
        });
        mountedUserIdsRef.current.add(p.uuid);
        return;
      }

      // Docked panel. Tab into the first same-side group if one exists.
      const anchorId = dockedGroupAnchorRef.current.get(p.dock);
      const anchorPanel = anchorId ? api.getPanel(anchorId) : null;
      const isHorizontal = p.dock === "left" || p.dock === "right";
      const userPanel = api.addPanel({
        id: p.uuid,
        component: "user-panel",
        title: p.title,
        position: anchorPanel
          ? { referencePanel: anchorPanel.id }
          : {
              referencePanel: CANVAS_PANEL_ID,
              direction: directionFromDock(p.dock),
            },
        ...(anchorPanel
          ? {}
          : isHorizontal
            ? { initialWidth: DEFAULT_DOCKED_SIZE }
            : { initialHeight: DEFAULT_DOCKED_SIZE }),
      });
      userPanel.group.api.setConstraints({
        minimumWidth: 200,
        minimumHeight: 120,
      });
      if (!anchorPanel) {
        dockedGroupAnchorRef.current.set(p.dock, p.uuid);
      }
      mountedUserIdsRef.current.add(p.uuid);
    });

    Array.from(mountedUserIdsRef.current).forEach((id) => {
      if (want.has(id)) return;
      const panel = api.getPanel(id);
      if (panel) api.removePanel(panel);
      mountedUserIdsRef.current.delete(id);
      // If this id was an anchor, clear it so the next docked panel on
      // that side creates a fresh group.
      dockedGroupAnchorRef.current.forEach((anchorId, side) => {
        if (anchorId === id) dockedGroupAnchorRef.current.delete(side);
      });
    });
  }, [userPanels]);

  React.useEffect(syncUserPanels, [syncUserPanels]);

  const handleReady = React.useCallback(
    (event: DockviewReadyEvent) => {
      apiRef.current = event.api;

      const canvasPanel = event.api.addPanel({
        id: CANVAS_PANEL_ID,
        component: "canvas",
        title: "View",
      });
      canvasPanel.group.locked = true;
      canvasPanel.group.model.header.hidden = true;
      canvasPanel.group.api.setConstraints({
        minimumWidth: 320,
        minimumHeight: 240,
      });

      syncUserPanels();
    },
    [syncUserPanels],
  );

  const themeClass =
    colorScheme === "dark" ? "dockview-theme-dark" : "dockview-theme-light";

  return (
    <CanvasNodeContext.Provider value={canvas}>
      <div
        style={{ position: "relative", flexGrow: 1, overflow: "hidden" }}
        className={`viser-dock-host ${themeClass}`}
      >
        <DockviewReact
          components={components}
          onReady={handleReady}
          floatingGroupBounds={{
            minimumHeightWithinViewport: 80,
            minimumWidthWithinViewport: 120,
          }}
        />
      </div>
    </CanvasNodeContext.Provider>
  );
}
