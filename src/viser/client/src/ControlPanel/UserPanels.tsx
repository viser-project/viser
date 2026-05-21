// @refresh reset

import { Box } from "@mantine/core";
import React from "react";
import { ViewerContext } from "../ViewerContext";
import FloatingPanel from "./FloatingPanel";
import GeneratedGuiContainer from "./Generated";

interface SavedGeometry {
  width: string;
  x: number;
  y: number;
}

function loadGeometry(key: string): SavedGeometry | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as SavedGeometry) : null;
  } catch {
    return null;
  }
}

function saveGeometry(key: string, g: SavedGeometry) {
  try {
    window.localStorage.setItem(key, JSON.stringify(g));
  } catch {
    /* ignore */
  }
}

/** Render every `GuiPanelMessage` under root as its own floating window. */
export default function UserPanels() {
  const viewer = React.useContext(ViewerContext)!;
  const rootUuids = viewer.useGui(
    (state) => state.guiUuidSetFromContainerUuid["root"] ?? {},
  );
  const useGuiConfig = viewer.useGuiConfig;

  const panelUuids = React.useMemo(() => {
    const panels: { uuid: string; order: number }[] = [];
    for (const uuid of Object.keys(rootUuids)) {
      const conf = useGuiConfig.get(uuid);
      if (conf?.type === "GuiPanelMessage") {
        panels.push({ uuid, order: conf.props.order });
      }
    }
    panels.sort((a, b) => a.order - b.order);
    return panels.map((p) => p.uuid);
  }, [rootUuids, useGuiConfig]);

  return (
    <>
      {panelUuids.map((uuid) => (
        <UserPanel key={uuid} uuid={uuid} />
      ))}
    </>
  );
}

/** Resolve a single "center"-or-pixel coordinate against panel+parent sizes.
 * Uses FloatingPanel's unfixed-offset convention: negative = right/bottom
 * anchor, positive = left/top anchor. */
function resolveCoord(
  coord: number | "center",
  panelSize: number,
  parentSize: number,
): number {
  if (coord === "center") return Math.max(0, (parentSize - panelSize) / 2);
  return coord;
}

function UserPanel({ uuid }: { uuid: string }) {
  const viewer = React.useContext(ViewerContext)!;
  const conf = viewer.useGuiConfig(uuid);
  const storageKey = `viser-panel-${uuid}`;
  const saved = React.useMemo(() => loadGeometry(storageKey), [storageKey]);

  if (conf?.type !== "GuiPanelMessage" || !conf.props.visible) return null;
  const p = conf.props;

  // Translate "center" into a concrete pixel offset measured from the
  // viewer's top-left. Parent/panel sizes are approximated at construction
  // time; the panel will still be clamped inside the viewer by
  // FloatingPanel's own ResizeObserver pass.
  const initialWidth = saved?.width ?? `${p.initial_width_px}px`;
  const parentW = window.innerWidth;
  const parentH = window.innerHeight;
  const initialPosition: [number, number] = saved
    ? [saved.x, saved.y]
    : [
        resolveCoord(p.initial_x, p.initial_width_px, parentW),
        resolveCoord(p.initial_y, 400, parentH),
      ];

  return (
    <FloatingPanel
      width={initialWidth}
      initialPosition={initialPosition}
      resizable={p.resizable}
      minWidthPx={p.min_width_px}
      maxWidthPx={p.max_width_px}
      onGeometryChange={(g) => saveGeometry(storageKey, g)}
    >
      <FloatingPanel.Handle>
        <Box style={{ flexGrow: 1, fontWeight: 500, userSelect: "none" }}>
          {p.title}
        </Box>
      </FloatingPanel.Handle>
      <FloatingPanel.Contents>
        {p.layout === "row" ? (
          <div className="viser-panel-row">
            <GeneratedGuiContainer containerUuid={uuid} />
          </div>
        ) : (
          <GeneratedGuiContainer containerUuid={uuid} />
        )}
      </FloatingPanel.Contents>
    </FloatingPanel>
  );
}
