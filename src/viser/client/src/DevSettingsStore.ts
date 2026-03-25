import React from "react";
import { create } from "zustand";

type DevSettingsState = {
  showStats: boolean;
  fixedDpr: number | null;
  logCamera: boolean;
  enableOrbitCrosshair: boolean;
};

/** Create a dev settings store with initial values from URL search params for backward compatibility */
export function useDevSettingsStore() {
  return React.useState(() => {
    const searchParams = new URLSearchParams(window.location.search);

    // Parse initial values from search params
    const showStats = searchParams.get("showStats") !== null;
    const fixedDprParam = searchParams.get("fixedDpr");
    const fixedDpr = fixedDprParam ? parseFloat(fixedDprParam) : null;
    const logCamera = searchParams.get("logCamera") !== null;

    return create<DevSettingsState>(() => ({
      showStats,
      fixedDpr,
      logCamera,
      enableOrbitCrosshair: true,
    }));
  })[0];
}
