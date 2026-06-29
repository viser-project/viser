/** The control panel's fixed pane id. Shared with the Python `CONTROL_PANEL_ID`
 * (the anchor uuid for `main_panel`), and used by sync code to locate the
 * control panel's group/window via findPaneGroup + findGroupLocation. In its own
 * module so non-component files can import it without coupling to a component
 * file (which would break React fast-refresh). */
export const CONTROL_PANEL_ID = "viser-control-panel";
