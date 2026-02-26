import React from "react";
import { create } from "zustand";
import { EnvironmentMapMessage, FogMessage } from "./WebsocketMessages";

type EnvironmentState = {
  enableDefaultLights: boolean;
  enableDefaultLightsShadows: boolean;
  environmentMap: EnvironmentMapMessage;
  fog: FogMessage;
};

/** Declare an environment state, and return a hook for accessing it. Note that we put
effort into avoiding a global state! */
export function useEnvironmentState() {
  return React.useState(() =>
    create<EnvironmentState>(() => ({
      enableDefaultLights: true,
      enableDefaultLightsShadows: true,
      environmentMap: {
        type: "EnvironmentMapMessage",
        hdri: "city",
        background: false,
        background_blurriness: 0,
        background_intensity: 1.0,
        background_wxyz: [1, 0, 0, 0],
        environment_intensity: 1.0,
        environment_wxyz: [1, 0, 0, 0],
      },
      fog: {
        type: "FogMessage",
        near: 10.0,
        far: 50.0,
        color: [255, 255, 255],
        enabled: false,
      },
    })),
  )[0];
}
