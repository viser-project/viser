import React from "react";

/** Which edge the floating control panel is docked to, or null when it's
 * freely floating over the canvas. */
export type DockSide = "left" | "right" | null;

export interface DockState {
  /** Edge the panel is docked to, or null when floating. */
  side: DockSide;
  /** CSS width of the panel; used to inset the canvas when docked. */
  width: string;
}

export interface DockContextType {
  dock: DockState;
  setDock: (dock: DockState) => void;
  /** Whether the panel is expanded. Lifted here so the canvas can stop
   * reserving space when a docked panel is collapsed. */
  expanded: boolean;
  toggleExpanded: () => void;
}

/** Shared between the canvas (which insets to make room for a docked panel)
 * and the FloatingPanel (which writes the dock state when dragged to an edge).
 *
 * Defaults to a floating panel (side: null), so non-floating layouts and the
 * un-docked state are unaffected. */
export const DockContext = React.createContext<DockContextType>({
  dock: { side: null, width: "20em" },
  setDock: () => undefined,
  expanded: true,
  toggleExpanded: () => undefined,
});
