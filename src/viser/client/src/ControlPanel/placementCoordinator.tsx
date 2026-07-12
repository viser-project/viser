// THE placement coordinator: one pass, over every panel, applying server
// placement to the dock. This replaces the previous per-panel effect fan-out
// (a placement effect + membership effect + hide effect + empty effect PER
// panel, plus a separate main-panel effect), which had to re-derive cross-
// panel ordering with component-local refs, a retry nonce, and a timeout.
//
// The coordinator's model is a FIXPOINT iteration instead of stateful
// deferral: the pass re-runs whenever any input changes -- the placement
// store, the panels store, the pane registry, the LAYOUT, or the reset nonce
// -- and each step is idempotent, so "this placement isn't applicable yet"
// (e.g. a split whose anchor hasn't docked) is simply skipped and re-evaluated
// on the next pass. Applying a placement commits a layout, which re-runs the
// pass, which applies whatever that unblocked. Convergence is guaranteed by
// per-panel dedup: a PLACED panel's placement bundle is applied at most once
// (keyed by its serialized form), and every other step no-ops on repeat.
//
// Per-panel bookkeeping is plain data in one map (no per-panel hooks):
//   appliedPlacementKey -- last bundle applied while placed (dedup). Dedup is
//     ONLY honored while the panel is placed: an unplaced panel (fresh, shown
//     after hide, group lost in a container swap) always re-attempts, which
//     unifies first-placement, re-show, and the old "ungrouped recovery"
//     fallback into the one placement step.
//   prevOrderKey / prevTabIds -- membership diffing (which tabs were REMOVED,
//     so reconciliation never drops a foreign pane the user merged in).
//   lastTabIds -- cleanup set for a panel emptied to zero tabs.

import React from "react";
import { ViewerContext } from "../ViewerContext";
import { DockMetrics, DockMetricsContext, useDock } from "../dock/DockContext";
import * as ops from "../dock/layoutOps";
import type { CanvasBounds } from "../dock/layoutOps";
import { DockLayout } from "../dock/types";
import { CONTROL_PANEL_ID } from "./controlPanelId";
import { buildPaneToStableKey } from "./panelIdentity";
import { gatePlacement } from "./placementGate";

/** The canvas bounds (for resolving float placements) from the dock metrics. */
export function canvasBoundsFromMetrics(metrics: DockMetrics): CanvasBounds {
  return {
    width: metrics.containerWidth,
    height: metrics.containerHeight,
    leftInset: metrics.reservedWidth.left,
    rightInset: metrics.reservedWidth.right,
  };
}

interface PanelBookkeeping {
  appliedPlacementKey: string | null;
  prevOrderKey: string | null;
  prevTabIds: string[];
  lastTabIds: string[];
}

const freshBookkeeping = (): PanelBookkeeping => ({
  appliedPlacementKey: null,
  prevOrderKey: null,
  prevTabIds: [],
  lastTabIds: [],
});

/** Mount the placement coordinator. `mapMainPlacement` lets the control panel
 * rewrite its own bundle before application (the default top-right float). */
export function usePlacementCoordinator(
  mapMainPlacement: (placement: ops.PanelPlacement) => ops.PanelPlacement,
): void {
  const viewer = React.useContext(ViewerContext)!;
  const dock = useDock();
  const metrics = React.useContext(DockMetricsContext);

  const panels = viewer.useGui((state) => state.panels);
  const panelPlacement = viewer.useGui((state) => state.panelPlacement);
  const tracking = viewer.useGui((state) => state.panelLayoutTracking);
  const layoutResetNonce = viewer.useGui((state) => state.layoutResetNonce);

  const bookkeeping = React.useRef(new Map<string, PanelBookkeeping>());
  const lastResetNonce = React.useRef(layoutResetNonce);

  React.useEffect(() => {
    // A layout reset re-applies every panel's server placement from scratch.
    if (lastResetNonce.current !== layoutResetNonce) {
      lastResetNonce.current = layoutResetNonce;
      for (const state of bookkeeping.current.values())
        state.appliedPlacementKey = null;
    }
    // Drop bookkeeping for panels that no longer exist (uuid-keyed, so a
    // removed panel's entry is dead; the layout-tracking store prunes its own
    // stable-key entries separately).
    for (const uuid of bookkeeping.current.keys())
      if (uuid !== CONTROL_PANEL_ID && panels[uuid] === undefined)
        bookkeeping.current.delete(uuid);

    const layout = dock.layout;
    const stableKeys = buildPaneToStableKey(panels);
    const resolveAnchor = (anchorUuid: string): string | null => {
      if (anchorUuid === CONTROL_PANEL_ID)
        return ops.findPaneGroup(layout, CONTROL_PANEL_ID);
      const firstPane = panels[anchorUuid]?.props._tab_container_ids[0];
      return firstPane === undefined
        ? null
        : ops.findPaneGroup(layout, firstPane);
    };
    const anchorDocked = (anchorUuid: string): boolean => {
      const gid = resolveAnchor(anchorUuid);
      return (
        gid !== null && ops.findGroupLocation(layout, gid)?.kind === "docked"
      );
    };
    // Whether the anchor's own dock is still COMING -- decided synchronously
    // from the store, never a timer. Deferring is only correct while progress
    // is POSSIBLE, so every "can never dock" case must return false (the
    // dependent then applies with the op's warn + right-edge fallback instead
    // of hanging invisible):
    //  - stored position absent or float: the server never intends a dock;
    //  - the anchor's placement step can't RUN: a hidden panel or one emptied
    //    to zero tabs early-returns before placing;
    //  - its gate is closed (e.g. the user floated it): the dock won't
    //    re-apply;
    //  - a split-anchored anchor waits on ITS anchor in turn -- followed
    //    recursively, with a visited set so an anchor CYCLE (a above b, b
    //    above a: neither can move first) reads as not-pending rather than
    //    deadlocking the fixpoint.
    const anchorDockPending = (
      anchorUuid: string,
      visited: Set<string> = new Set(),
    ): boolean => {
      if (visited.has(anchorUuid)) return false; // cycle: nobody moves first.
      visited.add(anchorUuid);
      if (anchorUuid !== CONTROL_PANEL_ID) {
        const anchorPanel = panels[anchorUuid];
        if (
          anchorPanel === undefined ||
          !anchorPanel.props.visible ||
          anchorPanel.props._tab_container_ids.length === 0
        )
          return false;
      }
      const anchorEntry = panelPlacement[anchorUuid];
      const pos = anchorEntry?.position?.value;
      if (pos === undefined || pos.kind === "float") return false;
      const anchorKey =
        anchorUuid === CONTROL_PANEL_ID
          ? CONTROL_PANEL_ID
          : (stableKeys.get(anchorUuid) ?? anchorUuid);
      const gated = gatePlacement(
        anchorEntry,
        tracking[anchorKey],
        resolveAnchor(anchorUuid) !== null,
      );
      if (gated.placement.position === null) return false;
      if (pos.kind === "split")
        return (
          anchorDocked(pos.anchor_uuid) ||
          anchorDockPending(pos.anchor_uuid, visited)
        );
      return true;
    };

    const processPanel = (uuid: string): void => {
      const isMain = uuid === CONTROL_PANEL_ID;
      const panel = isMain ? null : panels[uuid];
      const tabIds: string[] = isMain
        ? [CONTROL_PANEL_ID]
        : [...(panel?.props._tab_container_ids ?? [])];
      const visible = isMain ? true : (panel?.props.visible ?? true);
      const entry = panelPlacement[uuid];
      const stableKey = isMain
        ? CONTROL_PANEL_ID
        : (stableKeys.get(uuid) ?? uuid);
      let state = bookkeeping.current.get(uuid);
      if (state === undefined) {
        state = freshBookkeeping();
        bookkeeping.current.set(uuid, state);
      }

      // 1. Hidden: remove the panel's panes from the layout (it renders
      // nothing) without destroying the panel; clearing the applied key makes
      // re-showing re-place it (it will be UNPLACED then, so the full stored
      // bundle applies).
      if (!visible) {
        state.appliedPlacementKey = null;
        if (tabIds.length > 0)
          dock.api.apply((l) => {
            let next = l;
            for (const id of tabIds) next = ops.removePane(next, id);
            return next;
          });
        return;
      }

      // 2. Emptied to ZERO tabs while visible: remove the now-dead panes
      // (collapsing the group/leaf) and forget the applied placement so a
      // repopulated panel re-places cleanly.
      if (!isMain && tabIds.length === 0) {
        state.appliedPlacementKey = null;
        const dead = state.lastTabIds;
        if (dead.length > 0)
          dock.api.apply((l) => {
            let next = l;
            for (const id of dead) next = ops.removePane(next, id);
            return next;
          });
        return;
      }
      state.lastTabIds = tabIds;

      // 3. Panes must be registered before placing/reconciling (placing
      // earlier races the registry reconciliation). Not an error: the pass
      // re-runs when dock.panes changes.
      const ready = tabIds.every((cid) => dock.panes[cid] !== undefined);
      if (!ready) return;

      // 4. Placement: gate -> (defer?) -> apply -> record.
      const placementKey = JSON.stringify(entry ?? null);
      const placed = ops.findPaneGroup(layout, tabIds[0]) !== null;
      const applyGated = (): void => {
        const gated = gatePlacement(entry, tracking[stableKey], placed);
        if (entry !== undefined && placed && !gated.anyFresh) {
          // Nothing fresh; remember we evaluated this bundle.
          state.appliedPlacementKey = placementKey;
          return;
        }
        const pos = gated.placement.position;
        if (
          pos !== null &&
          pos.kind === "split" &&
          !anchorDocked(pos.anchor_uuid) &&
          anchorDockPending(pos.anchor_uuid)
        ) {
          // The anchor's own dock is on its way (possibly later in THIS
          // pass); leave the applied key unset so the next pass -- triggered
          // by the anchor's commit -- retries. No timer, no pending state.
          return;
        }
        state.appliedPlacementKey = placementKey;
        if (entry !== undefined)
          viewer.guiActions.recordPanelLayoutApplied(stableKey, gated.applied);
        const placement = isMain
          ? mapMainPlacement(gated.placement)
          : gated.placement;
        dock.api.apply((l: DockLayout) =>
          ops.applyPanelPlacement(
            l,
            tabIds,
            placement,
            (anchorUuid) => resolveAnchor(anchorUuid),
            {
              canvasBounds: canvasBoundsFromMetrics(metrics),
              // The control panel is floated separately (the initial-placement
              // effect); don't let a no-position bundle double-place it.
              floatIfUnplaced: !isMain,
            },
          ),
        );
      };
      // Dedup ONLY while placed (see header): an unplaced panel always
      // re-attempts, which covers first placement, re-show after hide, and
      // recovery from a full tab-container swap in one rule.
      if (!placed || state.appliedPlacementKey !== placementKey) applyGated();

      // 5. Membership: tabs added/removed reconcile WITHOUT repositioning.
      // The REMOVED set is diffed here so reconciliation drops exactly the
      // server-removed tabs -- never a foreign pane the user merged in.
      if (!isMain) {
        const orderKey = tabIds.join("\n");
        if (state.prevOrderKey !== orderKey) {
          const removed = state.prevTabIds.filter((id) => !tabIds.includes(id));
          state.prevOrderKey = orderKey;
          state.prevTabIds = tabIds;
          dock.api.apply((l) =>
            ops.reconcilePanelMembership(l, tabIds, removed),
          );
        }
      }
    };

    // Main panel first: it is everyone's potential split anchor.
    processPanel(CONTROL_PANEL_ID);
    for (const uuid of Object.keys(panels)) processPanel(uuid);
    // `dock.layout` is a dependency ON PURPOSE: it is what turns deferral into
    // a fixpoint (an anchor docking commits a layout, which re-runs the pass).
    // Every step dedups, so the steady-state pass is a cheap no-op scan.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    panels,
    panelPlacement,
    tracking,
    layoutResetNonce,
    dock.layout,
    dock.panes,
    dock.api,
    metrics,
  ]);
}
