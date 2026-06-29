// Bridge between server-driven GUI tab groups and the docking surface.
//
// A GUI tab group rendered inside the dock surface registers itself here; the
// surface then OWNS the lifetime of the tabs' panel specs, keeping them
// registered (and their labels/icons fresh) by subscribing to the tab group's
// config -- independent of whether the tab group component is currently
// mounted (it unmounts whenever an ancestor tab is inactive). When the server
// removes the tab group, the surface drops its specs and the dock layout
// removes the panes from wherever the user moved them.

import React from "react";

export interface GuiDockContextValue {
  /** Register a tab container (by uuid) as a source of dock panes. `source`
   * selects where its tab content lives: "gui" for an inline tab group (config
   * store), "panel" for a standalone panel (panels store). Idempotent; safe to
   * call on every render. There is deliberately no unregister -- spec lifetime
   * follows the SERVER config, not component mount state. */
  registerTabGroup: (uuid: string, source?: "gui" | "panel") => void;
}

/** Null outside the dock surface (sidebar/mobile layouts, modals): GUI tab
 * groups then render as plain non-dockable tabs. */
export const GuiDockContext = React.createContext<GuiDockContextValue | null>(
  null,
);
