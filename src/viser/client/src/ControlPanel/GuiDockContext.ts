// Bridge between server-driven GUI tab groups and the docking surface.
//
// A GUI tab group rendered inside the dock surface registers itself here; the
// surface then OWNS the lifetime of the tabs' panel specs, keeping them
// registered (and their labels/icons fresh) by subscribing to the tab group's
// config -- independent of whether the tab group component is currently
// mounted (it unmounts whenever an ancestor tab is inactive). When the server
// removes the tab group, the surface drops its specs and the dock layout
// removes the panels from wherever the user moved them.

import React from "react";

export interface GuiDockContextValue {
  /** Register a GUI tab group (by uuid) as a source of dock panels. Idempotent;
   * safe to call on every render. There is deliberately no unregister -- spec
   * lifetime follows the SERVER config, not component mount state. */
  registerTabGroup: (uuid: string) => void;
}

/** Null outside the dock surface (sidebar/mobile layouts, modals): GUI tab
 * groups then render as plain non-dockable tabs. */
export const GuiDockContext = React.createContext<GuiDockContextValue | null>(
  null,
);
