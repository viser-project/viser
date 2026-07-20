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
import { DockMetricsContext, useDock } from "../dock/DockContext";
import { DockManager } from "../dock/DockManager";
import * as ops from "../dock/layoutOps";
import { PANEL_PAD_PX, PaneRegistry, emptyLayout } from "../dock/types";
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
import { usePlacementCoordinator } from "./placementCoordinator";

// Memoized so a torn-out tab's whole GUI tree doesn't re-render every time
// unrelated dock state changes (it only depends on its container uuid).
const MemoizedGeneratedGuiContainer = React.memo(GeneratedGuiContainer);

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
  // The control panel's title (shown e.g. on its minimized strip): the
  // server-set label, falling back to "Control panel".
  const label = viewer.useGui((state) => state.label);

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
        title: label || "Control panel",
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
        // Minimized face (D19): the same connection-status row the expanded
        // header shows, action icons omitted -- the panel keeps its identity
        // when collapsed to its bar (old-viser continuity via the general
        // pane mechanism, not a special case).
        minimizedFace: <ConnectionStatus />,
        render: () => <ControlPanelContents showSettings={showSettings} />,
      },
    }),
    [showSettings, toggle, label],
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

  // Layout-tracking pruning has exactly two homes, neither here: removePanel
  // (a live removal's uuid can never return) and the replayDone action (the
  // one point where the panel set is provably complete for a connection). A
  // mid-replay prune keyed on the panel set raced the replay's message
  // windows and could drop a still-loading panel's applied high-water marks.
  // There is no per-gesture "user touched" marking either (D52): the applied
  // marks recorded by the placement coordinator are the whole arbitration
  // state, so user gestures need no bookkeeping at all here.

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
      // Content gone while a (re)connect replay is in flight: DORMANT, not
      // dead. resetGui empties the stores before the replay re-delivers them,
      // and the replay re-creates surviving entities under the SAME uuids --
      // tearing down here would drop the pane specs, let the dock reconcile
      // the panes out of the layout, and re-seed server placement over the
      // user's arrangement (the reconnect-destroys-layout bug). Keep the
      // entry, subscription, and pane specs; reset the signature so the
      // revived content always re-applies. Entries the replay does NOT revive
      // are purged at the ReplayDoneMessage (the purge effect below).
      if (content === null && viewer.useGui.get().replayActive) {
        entry.sig = "\0unset";
        return;
      }
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
  // Purge, at end-of-replay, the dormant entries the replay did not revive:
  // their entity was removed while we were disconnected, or the server
  // restarted with fresh uuids. This is the ONE point where "content is null"
  // provably means "gone" rather than "not delivered yet".
  const replayDoneNonce = viewer.useGui((state) => state.replayDoneNonce);
  React.useEffect(() => {
    if (replayDoneNonce === 0) return; // no connection has completed a replay
    const dead: string[] = [];
    for (const [uuid, entry] of registry.current)
      if (tabContentProvider(viewer, entry.source).get(uuid) === null)
        dead.push(uuid);
    for (const uuid of dead) refreshTabGroup(uuid); // replayActive=false: deletes
  }, [replayDoneNonce, viewer, refreshTabGroup]);
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

  // Client-owned placement for the control panel (`main_panel` commands).
  // Overrides the default top-right float.
  const mainPlacementEntry = viewer.useGui(
    (state) => state.panelPlacement[CONTROL_PANEL_ID],
  );

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

  // THE placement coordinator: one pass over the control panel + every
  // standalone panel, applying server placement (gate -> defer -> apply ->
  // record) as a fixpoint over store/layout changes. See
  // placementCoordinator.tsx. The control panel's one special rewrite: a
  // DEFAULT float (kind float, both coords null -- gui.reset()'s "return to
  // the default") resolves to the top-right geometry (the dock's bare float
  // default is top-LEFT).
  usePlacementCoordinator(
    React.useCallback(
      (placement) => {
        const pos = placement.position;
        const defaultFloat =
          pos !== null &&
          pos.kind === "float" &&
          pos.x === null &&
          pos.y === null;
        if (!defaultFloat) return placement;
        // Canvas-INDEPENDENT top-right: negative x is the dock's "gap from
        // the right edge" anchor form, re-resolved against the live canvas on
        // every resize. topRightGeometry()'s absolute coords would freeze
        // whatever canvas width existed at apply time -- an early apply
        // during startup recorded 960px-era coords as a left-relative anchor
        // and the panel sat mid-canvas once the viewport reached 1280px
        // (caught by test_floating_panel_default_placement in CI).
        return {
          ...placement,
          position: { kind: "float", x: -PANEL_PAD_PX, y: PANEL_PAD_PX },
          width: placement.width ?? topRightGeometry().width,
        };
      },
      [topRightGeometry],
    ),
  );

  // Where is the control panel now?
  const controlGroupId = ops.findPaneGroup(dock.layout, CONTROL_PANEL_ID);
  const location =
    controlGroupId === null
      ? null
      : ops.findGroupLocation(dock.layout, controlGroupId);
  const side: "left" | "right" | "none" =
    location?.kind === "docked" ? location.edge : "none";
  // D38: collapse is container state, so "expanded" derives from the panel's
  // container (window collapsed / column railed / region collapsed).
  const expanded =
    controlGroupId === null ||
    !ops.isGroupEffectivelyCollapsed(dock.layout, controlGroupId);
  // The panel's element-identity signature for the decorate effect below:
  // where it sits (window / leaf node -- restructures mint fresh ids) plus
  // its collapse state (expanded<->minimized swaps which element carries the
  // handle testid). Per-frame geometry commits leave this unchanged.
  const locationKey =
    location === null
      ? "none"
      : `${
          location.kind === "floating"
            ? `f:${location.windowId}`
            : location.kind === "docked"
              ? `d:${location.edge}:${location.nodeId}`
              : location.kind
        }:${expanded ? "e" : "c"}`;
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
  const placementWidth = mainPlacementEntry?.width?.value ?? null;
  // The width axis's (counter, runId) stamp joins the key: a reconnect replay
  // repopulates the SAME stamp, so the key round-trips to its pre-reset value
  // and the effect stays quiet -- previously the replay's theme->stored flip
  // re-applied a stale width over a user resize, bypassing the gate entirely.
  const placementWidthStamp =
    mainPlacementEntry?.width === undefined
      ? "none"
      : `${mainPlacementEntry.width.runId}:${mainPlacementEntry.width.counter}`;
  const widthKey = `${placementWidth ?? "theme"}@${placementWidthStamp}:${widthPx}`;
  const replayActive = viewer.useGui((state) => state.replayActive);
  const appliedWidthKey = React.useRef<string | null>(null);
  React.useLayoutEffect(() => {
    // Hold during a (re)connect replay: the store flips through
    // empty-then-replayed states that are not width COMMANDS (the key
    // restores itself once the replay lands; a genuinely new command changes
    // the stamp and applies on the first post-replay run).
    if (replayActive) return;
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
  }, [
    widthKey,
    replayActive,
    dock.api,
    fitToContainer,
    placementWidth,
    widthPx,
  ]);

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
    // would churn DOM attributes per resize frame. Keyed on a LOCATION
    // signature, not the layout object: per-frame gesture commits clone the
    // layout ~60x/s while the panel's element identity is stable, and each
    // re-run pays ~5 subtree querySelectors plus attribute writes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationKey, side, controlGroupId]);

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
        <StandalonePanelRegistration
          key={uuid}
          uuid={uuid}
          registerTabGroup={registerTabGroup}
        />
      ))}
    </>
  );
}

/** Per-panel content registration ONLY: the panel's tabs become panes in the
 * dock registry (their content lives in the panels store). All PLACEMENT is
 * owned by the placement coordinator (see placementCoordinator.tsx), which
 * runs one pass over every panel -- this component deliberately has no
 * placement logic. */
function StandalonePanelRegistration({
  uuid,
  registerTabGroup,
}: {
  uuid: string;
  registerTabGroup: (uuid: string, source?: "gui" | "panel") => void;
}) {
  React.useEffect(() => {
    registerTabGroup(uuid, "panel");
  }, [uuid, registerTabGroup]);
  return null;
}
