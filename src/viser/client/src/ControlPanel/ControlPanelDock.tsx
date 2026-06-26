// The "floating" control-panel layout, on the docking library.
//
// Mounts a DockManager over the canvas area and seeds it with ONE panel: the
// control panel, as an unmergeable floating window in the top-right corner --
// matching the original FloatingPanel's default placement and feature set
// (drag, dock to either edge with canvas inset, resize from both edges,
// click-the-handle to minimize). Because it's an ordinary dock panel, it also
// composes with any other panes later added to the surface (e.g. GUI tabs
// dragged out of a nested dockable area).

import { Box } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import React from "react";
import { ViewerContext, ViewerContextContents } from "../ViewerContext";
import { htmlIconWrapper } from "../components/ComponentStyles.css";
import { DockMetrics, DockMetricsContext, useDock } from "../dock/DockContext";
import { DockManager } from "../dock/DockManager";
import * as ops from "../dock/layoutOps";
import { DockLayout, PaneRegistry, emptyLayout } from "../dock/types";
import type { CanvasBounds } from "../dock/layoutOps";
import {
  CommandsButton,
  ConnectionStatus,
  ControlPanelContents,
  SettingsToggleIcon,
  ShareButton,
} from "./ControlPanel";
import GeneratedGuiContainer from "./Generated";
import { GuiDockContext } from "./GuiDockContext";
import { shallowArrayEqual } from "../utils/shallowArrayEqual";
import { controlWidthPx } from "./controlWidth";
import { CONTROL_PANEL_ID } from "./controlPanelId";

// Memoized so a torn-out tab's whole GUI tree doesn't re-render every time
// unrelated dock state changes (it only depends on its container uuid).
const MemoizedGeneratedGuiContainer = React.memo(GeneratedGuiContainer);

// Match the original FloatingPanel's 15px boundary pad for initial placement.
const PANEL_PAD_PX = 15;

/** The canvas bounds (for resolving float placements) from the dock metrics. */
function canvasBoundsFromMetrics(metrics: DockMetrics): CanvasBounds {
  return {
    width: metrics.containerWidth,
    height: metrics.containerHeight,
    leftInset: metrics.reservedWidth.left,
    rightInset: metrics.reservedWidth.right,
  };
}

/** Where the control panel currently sits, reported up to App so the
 * notifications layer can offset itself clear of a left-docked panel. */
export interface ControlDockState {
  side: "left" | "right" | null;
  widthPx: number;
  expanded: boolean;
  /** RENDERED width (px) of the ENTIRE left-docked region -- the control panel
   * AND any standalone panels docked there. The notifications offset uses this
   * so a left-docked standalone panel isn't overlapped even when the control
   * panel itself is elsewhere. 0 when nothing is docked left. */
  leftRegionWidthPx: number;
}

export function ControlPanelDockSurface({
  children,
  onDockStateChange,
}: {
  /** Center content (the canvas layers), inset when the panel is docked. */
  children: React.ReactNode;
  onDockStateChange?: (state: ControlDockState) => void;
}) {
  const viewer = React.useContext(ViewerContext)!;
  const controlWidthString = viewer.useGui(
    (state) => state.theme.control_width,
  );
  const widthPx = controlWidthPx(controlWidthString);
  const [showSettings, { toggle }] = useDisclosure(false);

  // GUI tab groups rendered inside the dock surface register here (via
  // GuiDockContext); the registry hook owns the lifetime of their tabs' panel
  // specs.
  const { guiPanels, registerTabGroup } = useGuiTabPanelRegistry(viewer);
  const guiDockValue = React.useMemo(
    () => ({ registerTabGroup }),
    [registerTabGroup],
  );

  const controlPanelSpec: PaneRegistry = React.useMemo(
    () => ({
      [CONTROL_PANEL_ID]: {
        id: CONTROL_PANEL_ID,
        title: "Control panel",
        unmergeable: true,
        unpadded: true,
        titleNode: (
          <>
            <ConnectionStatus />
            {/* Action icons: stop pointerdown so pressing them neither starts
            a panel drag nor registers as a minimize click on the header. */}
            <Box
              style={{
                display: "flex",
                alignItems: "center",
                flexShrink: 0,
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <CommandsButton />
              <ShareButton />
              <SettingsToggleIcon
                showSettings={showSettings}
                onToggle={toggle}
              />
            </Box>
          </>
        ),
        render: () => <ControlPanelContents showSettings={showSettings} />,
      },
    }),
    [showSettings, toggle],
  );
  const panes: PaneRegistry = React.useMemo(
    () => ({ ...guiPanels, ...controlPanelSpec }),
    [guiPanels, controlPanelSpec],
  );

  // The DockManager mounts IMMEDIATELY around the canvas (an empty layout is
  // just a passthrough container) -- mounting it later would reparent the
  // children and remount the R3F canvas, recreating the WebGL context. The
  // control panel window is then placed by ControlPanelDockSync once the
  // container width is measurable (top-right anchored).
  const initialLayout = React.useMemo(() => emptyLayout(), []);

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      <GuiDockContext.Provider value={guiDockValue}>
        <DockManager
          initialLayout={initialLayout}
          panes={panes}
          // Resize the 3D canvas's GL backbuffer synchronously as a docked
          // region's width handle is dragged, so the scene tracks the divider
          // instead of trailing R3F's async ResizeObserver by a frame.
          onRegionResizeFrame={(w, h) =>
            viewer.mutable.current.syncCanvasSize?.(w, h)
          }
        >
          {children}
          <ControlPanelDockSync
            widthPx={widthPx}
            onDockStateChange={onDockStateChange}
          />
          <StandalonePanelSync registerTabGroup={registerTabGroup} />
        </DockManager>
      </GuiDockContext.Provider>
    </div>
  );
}

/** Owns the panel specs for GUI tab groups rendered inside the dock surface.
 * Each registered tab group gets a config-store subscription that keeps its
 * tabs' specs fresh (labels, icons, membership); when the SERVER removes the
 * tab group, its specs are dropped -- the DockManager's registry
 * reconciliation then removes the panes from wherever the user moved them.
 * Spec lifetime deliberately does NOT follow component mount state: a nested
 * tab group unmounts whenever an ancestor tab goes inactive, which must not
 * tear down its panes. */
/** A tab container's content: the three parallel tab tuples, or null when the
 * source entity no longer exists. */
interface TabContent {
  ids: readonly string[];
  labels: readonly string[];
  icons: readonly (string | null)[];
}

/** Where a registered tab container's content lives. Inline tab groups
 * (`DockableTabGroup`) read the config store; standalone panels read the panels
 * store. Both expose the same {get, subscribe} shape so the registry below is
 * source-agnostic. */
type TabContentSource = "gui" | "panel";

function tabContentProvider(
  viewer: ViewerContextContents,
  source: TabContentSource,
): {
  get: (uuid: string) => TabContent | null;
  subscribe: (uuid: string, cb: () => void) => () => void;
} {
  if (source === "panel") {
    return {
      get: (uuid) => {
        const panel = viewer.useGui.get().panels[uuid];
        if (panel === undefined) return null;
        return {
          ids: panel.props._tab_container_ids,
          labels: panel.props._tab_labels,
          icons: panel.props._tab_icons_html,
        };
      },
      // The panels store has no per-key subscribe; watch the whole store (panel
      // updates are infrequent, and the signature check below makes refreshes
      // that don't change tab content a no-op).
      subscribe: (_uuid, cb) => viewer.useGui.subscribe(cb),
    };
  }
  return {
    get: (uuid) => {
      const conf = viewer.useGuiConfig.get(uuid);
      if (conf === undefined || conf.type !== "GuiTabGroupMessage") return null;
      return {
        ids: conf.props._tab_container_ids,
        labels: conf.props._tab_labels,
        icons: conf.props._tab_icons_html,
      };
    },
    subscribe: (uuid, cb) => viewer.useGuiConfig.subscribe(uuid, cb),
  };
}

function useGuiTabPanelRegistry(viewer: ViewerContextContents): {
  guiPanels: PaneRegistry;
  registerTabGroup: (uuid: string, source?: TabContentSource) => void;
} {
  const [guiPanels, setGuiPanels] = React.useState<PaneRegistry>({});
  // Per tab container: its source subscription, the pane ids it owns, and a
  // signature of the last-applied tab content (ids/labels/icons).
  const registry = React.useRef(
    new Map<
      string,
      {
        unsubscribe: () => void;
        paneIds: string[];
        sig: string;
        source: TabContentSource;
      }
    >(),
  );

  const refreshTabGroup = React.useCallback(
    (uuid: string) => {
      const entry = registry.current.get(uuid);
      if (entry === undefined) return;
      const content = tabContentProvider(viewer, entry.source).get(uuid);
      // The source store fires for ANY change; only rebuild the specs (new
      // objects + icon elements, which re-renders every tab panel) when the tab
      // CONTENT actually changed.
      const sig =
        content === null
          ? ""
          : JSON.stringify([content.ids, content.labels, content.icons]);
      if (content !== null && sig === entry.sig) return;
      entry.sig = sig;
      const ownedBefore = new Set(entry.paneIds);
      if (content === null) {
        entry.unsubscribe();
        registry.current.delete(uuid);
      } else {
        entry.paneIds = [...content.ids];
      }
      setGuiPanels((prev) => {
        const next: PaneRegistry = {};
        for (const [pid, spec] of Object.entries(prev)) {
          if (!ownedBefore.has(pid)) next[pid] = spec;
        }
        if (content === null) return next;
        content.ids.forEach((cid: string, i: number) => {
          const iconHtml = content.icons[i];
          next[cid] = {
            id: cid,
            title: content.labels[i] ?? "Tab",
            icon:
              iconHtml == null ? undefined : (
                <div
                  className={htmlIconWrapper}
                  dangerouslySetInnerHTML={{ __html: iconHtml }}
                />
              ),
            unpadded: true,
            render: () => <MemoizedGeneratedGuiContainer containerUuid={cid} />,
          };
        });
        return next;
      });
    },
    [viewer],
  );
  const registerTabGroup = React.useCallback(
    (uuid: string, source: TabContentSource = "gui") => {
      if (registry.current.has(uuid)) return;
      registry.current.set(uuid, {
        unsubscribe: tabContentProvider(viewer, source).subscribe(uuid, () =>
          refreshTabGroup(uuid),
        ),
        paneIds: [],
        // Sentinel that never matches a real signature, so the first refresh
        // always applies.
        sig: "\0unset",
        source,
      });
      refreshTabGroup(uuid);
    },
    [viewer, refreshTabGroup],
  );
  React.useEffect(() => {
    const reg = registry.current;
    return () => reg.forEach((entry) => entry.unsubscribe());
  }, []);
  return { guiPanels, registerTabGroup };
}

/** Non-rendering sync node inside the DockManager:
 * - applies server-driven control_width changes to the floating window;
 * - reports the panel's dock side/width/minimized state up to App (for the
 *   notifications offset);
 * - decorates the panel's DOM with the `floating-panel*` test ids and
 *   `data-dock-side` attribute that the e2e suite (and any user tooling built
 *   against the original FloatingPanel) targets. */
function ControlPanelDockSync({
  widthPx,
  onDockStateChange,
}: {
  widthPx: number;
  onDockStateChange?: (state: ControlDockState) => void;
}) {
  const dock = useDock();
  const viewer = React.useContext(ViewerContext)!;
  const metrics = React.useContext(DockMetricsContext);
  const markerRef = React.useRef<HTMLSpanElement>(null);
  const resolveAnchor = useAnchorResolver();

  // Server-authored placement for the control panel (`main_panel` commands and
  // the deprecated `control_layout`). Overrides the default top-right float.
  const mainPanelPlacement = viewer.useGui((state) => state.mainPanelPlacement);

  // Narrow containers (small browser windows, split screens): shrink the
  // panel to fit with its padding rather than spilling past the right edge.
  // Shared by the initial placement and later server-driven width changes.
  const fitToContainer = React.useCallback((width: number) => {
    const containerW =
      markerRef.current?.closest("[data-dock-root]")?.getBoundingClientRect()
        .width ?? 1280;
    return {
      containerW,
      width: Math.max(160, Math.min(width, containerW - 2 * PANEL_PAD_PX)),
    };
  }, []);

  // The control panel's DEFAULT placement geometry: floated in the top-right
  // corner (the original FloatingPanel look). One source of the geometry, used
  // by the initial placement and the gui.reset() clear path.
  const topRightGeometry = React.useCallback(() => {
    const { containerW, width } = fitToContainer(widthPx);
    return {
      x: Math.max(PANEL_PAD_PX, containerW - width - PANEL_PAD_PX),
      y: PANEL_PAD_PX,
      width,
    };
  }, [fitToContainer, widthPx]);

  // Initial placement: top-right corner, like the original FloatingPanel.
  // Runs once on mount (addFloatingPane no-ops if the panel is already
  // placed, so a StrictMode double-run is harmless).
  React.useLayoutEffect(() => {
    const { x, y, width } = topRightGeometry();
    dock.api.apply(
      (layout) =>
        ops.addFloatingPane(layout, CONTROL_PANEL_ID, x, y, width).layout,
    );
    // Initial placement only; later width changes are applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Server-authored placement (main_panel.dock_* / float / minimize / set_*,
  // and the deprecated control_layout). Re-applies whenever the command changes.
  // `null` = the server never placed it (leave the default top-right float). An
  // empty placement OBJECT (position null, not collapsed, no size) = gui.reset()
  // cleared a prior placement: revert to the default float so a connected client
  // doesn't keep a now-stale dock.
  const mainPlacementKey = React.useMemo(
    () => JSON.stringify(mainPanelPlacement),
    [mainPanelPlacement],
  );
  React.useEffect(() => {
    if (mainPanelPlacement === null) return;
    const isCleared =
      mainPanelPlacement.position === null &&
      mainPanelPlacement.width === null &&
      mainPanelPlacement.height === null;
    if (isCleared) {
      // Re-float at the default top-right position (same geometry as the initial
      // placement).
      const { x, y, width } = topRightGeometry();
      dock.api.apply((layout) => {
        const gid = ops.findPaneGroup(layout, CONTROL_PANEL_ID);
        return gid === null
          ? layout
          : ops.floatGroup(layout, gid, x, y, width).layout;
      });
      return;
    }
    dock.api.apply((layout) =>
      ops.applyPanelPlacement(
        layout,
        [CONTROL_PANEL_ID],
        mainPanelPlacement,
        (anchorUuid) => resolveAnchor(layout, anchorUuid),
        // The control panel is floated separately (initial-placement effect);
        // don't let a no-position placement double-place it. A main_panel.float()
        // is canvas-relative like any other panel's.
        { floatIfUnplaced: false, canvasBounds: canvasBoundsFromMetrics(metrics) },
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mainPlacementKey, dock.api]);

  // Where is the control panel now?
  const controlGroupId = ops.findPaneGroup(dock.layout, CONTROL_PANEL_ID);
  const location =
    controlGroupId === null
      ? null
      : ops.findGroupLocation(dock.layout, controlGroupId);
  const side: "left" | "right" | "none" =
    location?.kind === "docked" ? location.edge : "none";
  const expanded =
    controlGroupId === null || dock.groups[controlGroupId]?.collapsed !== true;
  // RENDERED width (expanded px + strip/divider chrome): the notifications
  // offset must clear everything the region actually draws, not just the
  // expanded columns' model width.
  const dockedWidth =
    location?.kind === "docked"
      ? metrics.reservedWidth[location.edge]
      : widthPx;

  // Width of the FLOATING control panel: an explicit `main_panel.set_width()`
  // (placement.width) wins; otherwise the theme `control_width`. Resolving both
  // inputs here (rather than in two racing effects) means clearing a set_width
  // override cleanly reverts to the theme width. A docked panel keeps its region
  // width (placement effect / user drag), so we only touch floating.
  //
  // We track the inputs as a stable `widthKey` and read the px width INSIDE the
  // layout effect, not at render time: `fitToContainer` reads the DOM, and on
  // first render the marker ref isn't attached yet (it would return the 1280
  // fallback and overwrite the initial-placement effect's correctly-clamped
  // width on narrow containers). We read `fitToContainer` INSIDE a layout
  // effect (ref attached) and skip the first run, since the initial-placement
  // effect above already sized the window.
  const placementWidth = mainPanelPlacement?.width ?? null;
  const widthKey = `${placementWidth ?? "theme"}:${widthPx}`;
  const appliedWidthKey = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    // Seed on first run (the initial-placement effect owns the mount width).
    if (appliedWidthKey.current === null) {
      appliedWidthKey.current = widthKey;
      return;
    }
    if (appliedWidthKey.current === widthKey) return;
    appliedWidthKey.current = widthKey;
    const width = placementWidth ?? fitToContainer(widthPx).width;
    dock.api.apply((layout) => {
      const gid = ops.findPaneGroup(layout, CONTROL_PANEL_ID);
      const loc = gid === null ? null : ops.findGroupLocation(layout, gid);
      return loc?.kind === "floating"
        ? ops.resizeWindow(layout, loc.windowId, width)
        : layout;
    });
  }, [widthKey, dock.api, fitToContainer, placementWidth, widthPx]);

  // Report dock state up to App (notifications offset). `leftRegionWidthPx` is
  // the whole left-docked region (control panel + any standalone panels), so the
  // offset clears a left-docked standalone panel too -- not just the control one.
  const leftRegionWidthPx = metrics.reservedWidth.left;
  React.useEffect(() => {
    onDockStateChange?.({
      side: side === "none" ? null : side,
      widthPx: dockedWidth,
      expanded,
      leftRegionWidthPx,
    });
  }, [side, dockedWidth, expanded, leftRegionWidthPx, onDockStateChange]);

  // Decorate the panel's current DOM element with the original FloatingPanel
  // test ids. The dock library's elements are generic (any panel can float or
  // dock); these attributes identify WHICH of them is the control panel, kept
  // in a side effect so the library stays viser-agnostic.
  const decorated = React.useRef<Element[]>([]);
  React.useEffect(() => {
    for (const el of decorated.current) {
      el.removeAttribute("data-testid");
      el.removeAttribute("data-dock-side");
    }
    decorated.current = [];
    const root = markerRef.current?.closest("[data-dock-root]");
    if (root == null || location === null) return;
    const tag = (el: Element | null, testid: string) => {
      if (el === null) return;
      el.setAttribute("data-testid", testid);
      decorated.current.push(el);
    };
    const panelEl =
      location.kind === "floating"
        ? root.querySelector(`[data-floating-window="${location.windowId}"]`)
        : location.kind === "docked"
          ? root.querySelector(`[data-dock-leaf="${location.nodeId}"]`)
          : null;
    tag(panelEl, "floating-panel");
    panelEl?.setAttribute("data-dock-side", side);
    // Expanded: the unmergeable header is the handle. Minimized to a strip:
    // there is no header -- the strip CELL is the drag/click handle, so the
    // testid follows it (the original FloatingPanel kept its handle testid
    // through minimize).
    tag(
      root.querySelector(`[data-dock-header="${controlGroupId}"]`) ??
        root.querySelector(
          `[data-dock-group="${controlGroupId}"][data-dock-collapsed]`,
        ),
      "floating-panel-handle",
    );
    if (location.kind === "floating" && panelEl !== null) {
      tag(
        panelEl.querySelector('[data-dock-resize="left"]'),
        "floating-panel-resize-left",
      );
      tag(
        panelEl.querySelector('[data-dock-resize="right"]'),
        "floating-panel-resize-right",
      );
    }
    // Re-decorate only when the panel's element identity can actually change
    // (layout restructures recreate DOM nodes) -- not on every render, which
    // would churn DOM attributes per resize frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dock.layout, side, controlGroupId]);

  return <span ref={markerRef} style={{ display: "none" }} />;
}

/** Drives standalone panels (Python `server.gui.add_panel()`) on the dock
 * surface. Watches the dedicated panels store, registers each so its tabs become
 * panes (reusing the same registry as inline tab groups), and applies the
 * server's `placement` -- on create and whenever it changes. Renders one
 * non-visual sync node per standalone panel. */
function StandalonePanelSync({
  registerTabGroup,
}: {
  registerTabGroup: (uuid: string, source?: "gui" | "panel") => void;
}) {
  const viewer = React.useContext(ViewerContext)!;
  const panelUuids = viewer.useGui(
    (state) => Object.keys(state.panels),
    shallowArrayEqual,
  );
  return (
    <>
      {panelUuids.map((uuid) => (
        <StandalonePanelPlacement
          key={uuid}
          uuid={uuid}
          registerTabGroup={registerTabGroup}
        />
      ))}
    </>
  );
}

/** Resolve an anchor uuid (a standalone panel's uuid, or the control panel id)
 * to its current dock group, for split placements. The control panel's pane id
 * IS the control-panel id; a standalone panel's panes are its tab container ids,
 * so its group holds those panes. */
function useAnchorResolver(): (
  layout: ReturnType<typeof useDock>["layout"],
  uuid: string,
) => string | null {
  const viewer = React.useContext(ViewerContext)!;
  return React.useCallback(
    (layout, uuid) => {
      if (uuid === CONTROL_PANEL_ID) {
        return ops.findPaneGroup(layout, CONTROL_PANEL_ID);
      }
      const panel = viewer.useGui.get().panels[uuid];
      const firstPane = panel?.props._tab_container_ids[0];
      return firstPane === undefined
        ? null
        : ops.findPaneGroup(layout, firstPane);
    },
    [viewer],
  );
}

function StandalonePanelPlacement({
  uuid,
  registerTabGroup,
}: {
  uuid: string;
  registerTabGroup: (uuid: string, source?: "gui" | "panel") => void;
}) {
  const viewer = React.useContext(ViewerContext)!;
  const dock = useDock();
  const metrics = React.useContext(DockMetricsContext);
  const resolveAnchor = useAnchorResolver();

  // Register so the panel's tabs become panes in the dock registry (its content
  // lives in the panels store).
  React.useEffect(() => {
    registerTabGroup(uuid, "panel");
  }, [uuid, registerTabGroup]);

  // Subscribe to this panel's tab list + placement (from the panels store).
  const tabIds = viewer.useGui(
    (state) => state.panels[uuid]?.props._tab_container_ids ?? [],
    shallowArrayEqual,
  );
  const placement = viewer.useGui(
    (state) => state.panels[uuid]?.props.placement ?? null,
  );
  const expandByDefault = viewer.useGui(
    (state) => state.panels[uuid]?.props.expand_by_default ?? true,
  );
  const visible = viewer.useGui(
    (state) => state.panels[uuid]?.props.visible ?? true,
  );

  // The panel's panes must be registered (specs created) before we can place or
  // reconcile -- placing earlier races the registry reconciliation.
  const ready =
    tabIds.length > 0 && tabIds.every((cid) => dock.panes[cid] !== undefined);
  // Serialize the placement only when its (stable) object reference changes --
  // this component re-renders on every dock-layout commit, so avoid re-stringify
  // on unrelated churn.
  const placementKey = React.useMemo(
    () => JSON.stringify(placement),
    [placement],
  );
  const orderKey = tabIds.join("\n");

  // (1) Apply PLACEMENT only when the placement command itself changes (once
  // panes are ready). Crucially NOT on tab-list changes, and NOT merely because
  // `ready` flipped: re-docking on a tab add/remove would yank a panel the user
  // has since dragged elsewhere, breaking the "imperative, not continuous"
  // contract. We track the last-APPLIED placementKey in a ref, so a `ready`
  // false->true transition (which happens whenever a tab is added, since the new
  // pane registers a render later) re-runs this effect but is a no-op unless the
  // placement value actually changed.
  // Position from the LAST applied placement, so applyPanelPlacement can tell a
  // size-only re-placement (set_width: position unchanged) from a real move and
  // not yank a user-relocated panel back. Cleared on hide (re-show re-places).
  const appliedPosition = React.useRef<
    ops.PanelPlacement["position"] | undefined
  >(undefined);
  // Re-create + place this panel's group from its panes (used by the placement
  // effect and the ungrouped-recovery fallback below).
  const placePanel = (layout: DockLayout) =>
    placement === null
      ? layout
      : ops.applyPanelPlacement(
          layout,
          tabIds,
          placement,
          (anchorUuid) => resolveAnchor(layout, anchorUuid),
          {
            canvasBounds: canvasBoundsFromMetrics(metrics),
            expandByDefault,
            prevPosition: appliedPosition.current,
          },
        );

  const appliedPlacementKey = React.useRef<string | null>(null);
  React.useEffect(() => {
    // When hidden, drop the applied-key so re-showing re-places the panel.
    if (!visible) {
      appliedPlacementKey.current = null;
      appliedPosition.current = undefined;
      return;
    }
    if (!ready || placement === null) return;
    if (appliedPlacementKey.current === placementKey) return;
    appliedPlacementKey.current = placementKey;
    dock.api.apply(placePanel);
    appliedPosition.current = placement.position;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, placementKey, visible, dock.api]);

  // Hide/show: when `visible` is false, remove the panel's panes from the layout
  // (it renders nothing) without destroying the panel; when it flips back to
  // true the placement effect above re-applies. Keyed on `visible` + `orderKey`
  // so a tab added while hidden is also removed.
  React.useEffect(() => {
    if (visible || tabIds.length === 0) return;
    dock.api.apply((layout) => {
      let next = layout;
      for (const id of tabIds) next = ops.removePane(next, id);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, orderKey, dock.api]);

  // Remember the panel's last-known panes so the empty effect below can clean up
  // the dock layout when the panel is emptied (it has no current tabIds to look
  // the group up by). Updated in an effect (not during render) and only while
  // non-empty -- so on the emptying commit lastTabIds still holds the panes to
  // remove. Declared BEFORE the empty effect so it commits first on that render.
  const lastTabIds = React.useRef<string[]>([]);
  React.useEffect(() => {
    if (tabIds.length > 0) lastTabIds.current = tabIds;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderKey]);

  // Emptied to ZERO tabs (last tab removed) while still visible: remove the
  // panel's now-dead panes from the dock layout (collapsing its group/leaf) and
  // forget the applied placement, so re-populating the panel later re-places it
  // cleanly. Without this, a docked panel's stale group lingers (the membership
  // effect bails on !ready and the hide effect bails on visible), and a revive
  // creates a NEW group -- orphaning the stale one and rendering nowhere.
  // (Resets appliedPlacementKey, so it must stay declared AFTER the placement
  // effect; both touch that ref. Op idempotency makes the ordering self-healing,
  // but keep this order.)
  React.useEffect(() => {
    if (!visible || tabIds.length > 0) return;
    dock.api.apply((layout) => {
      let next = layout;
      for (const id of lastTabIds.current) next = ops.removePane(next, id);
      return next;
    });
    appliedPlacementKey.current = null;
    appliedPosition.current = undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, orderKey, dock.api]);

  // (2) Reconcile MEMBERSHIP (tabs added/removed) without repositioning, so a
  // tab change updates the group's panes but leaves its current location alone.
  // Edge case: if the server replaced ALL tab containers at once (zero overlap
  // with the old set), the panel's group can no longer be found by its panes, so
  // reconcile no-ops and the panel would render nowhere. Detect that (ready but
  // ungrouped) and fall back to re-applying the full placement, which re-creates
  // and re-places the group from the new panes.
  React.useEffect(() => {
    if (!ready || !visible) return;
    dock.api.apply((layout) =>
      placement !== null && ops.findPaneGroup(layout, tabIds[0]) === null
        ? placePanel(layout)
        : ops.reconcilePanelMembership(layout, tabIds),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, orderKey, visible, dock.api]);

  return null;
}
