// A STABLE identity per standalone panel that survives a program re-run (panel
// uuids are random per run): derived from the panel's tab labels -- the
// user-visible identity the program controls -- with creation `order` as a
// tiebreaker among panels that share the same labels. The layout-tracking store
// is keyed by this, so a panel with the same tabs re-binds to its remembered
// layout across a reconnect/re-run; renaming its tabs makes it a new panel.
//
// Shared by ControlPanelDock (placement gating, prune effect) and the GuiState
// store (pruning a panel's tracking when the server removes it) -- keep it free
// of store/React imports so both sides can use it without a cycle.

import type { GuiPanelMessage } from "../WebsocketMessages";

export type PanelsById = { [uuid: string]: GuiPanelMessage };

/** Build the uuid -> stableKey map in one pass (bucket by labels, number each
 * bucket by order) -- the single source of the identity rule. Labels are
 * NUL-joined so a label containing a space can't collide with a different
 * multi-tab split. */
export function computePaneToStableKey(panels: PanelsById): Map<string, string> {
  const byLabel = new Map<string, string[]>();
  for (const [uuid, p] of Object.entries(panels)) {
    const labels = p.props._tab_labels.join("\0");
    const bucket = byLabel.get(labels);
    if (bucket === undefined) byLabel.set(labels, [uuid]);
    else bucket.push(uuid);
  }
  const keys = new Map<string, string>();
  for (const [labels, uuids] of byLabel) {
    uuids.sort((a, b) => panels[a].props.order - panels[b].props.order);
    uuids.forEach((uuid, idx) => keys.set(uuid, `${labels}#${idx}`));
  }
  return keys;
}

// Single-entry memo keyed on the panels object identity. The gui store hands
// out a new `panels` object only when it actually changes, so all callers (the
// per-panel useStableKey selector, handleCommit, the prune effect, the store's
// removePanel) share one O(panels) build per change instead of each rebuilding
// it -- useStableKey in particular runs once per panel per store update, which
// would otherwise be O(panels^2).
let stableKeyCache: { panels: PanelsById; keys: Map<string, string> } | null =
  null;
export function buildPaneToStableKey(panels: PanelsById): Map<string, string> {
  if (stableKeyCache === null || stableKeyCache.panels !== panels)
    stableKeyCache = { panels, keys: computePaneToStableKey(panels) };
  return stableKeyCache.keys;
}
