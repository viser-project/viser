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

/** Build the uuid -> stableKey map in one pass -- the single source of the
 * identity rule.
 *
 * A panel with an EXPLICIT server-provided key (`add_panel(key=...)`) uses it
 * directly: identity is an input, immune to tab renames/reorders (the server
 * rejects duplicate keys among live panels). Panels without one fall back to
 * the label inference (bucket by NUL-joined labels -- so a label containing a
 * space can't collide with a different multi-tab split -- numbered by creation
 * order within a bucket). The two namespaces are prefixed ("k:" / "i:") so an
 * explicit key can never collide with an inferred one by construction. */
export function computePaneToStableKey(panels: PanelsById): Map<string, string> {
  const keys = new Map<string, string>();
  const byLabel = new Map<string, string[]>();
  for (const [uuid, p] of Object.entries(panels)) {
    const explicit = p.props._stable_key;
    if (explicit !== null) {
      keys.set(uuid, `k:${explicit}`);
      continue;
    }
    const labels = p.props._tab_labels.join("\0");
    const bucket = byLabel.get(labels);
    if (bucket === undefined) byLabel.set(labels, [uuid]);
    else bucket.push(uuid);
  }
  for (const [labels, uuids] of byLabel) {
    uuids.sort((a, b) => panels[a].props.order - panels[b].props.order);
    uuids.forEach((uuid, idx) => keys.set(uuid, `i:${labels}#${idx}`));
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
