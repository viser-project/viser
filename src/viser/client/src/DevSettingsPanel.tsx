import React from "react";
import { Switch, Select, Stack, Paper, Tooltip } from "@mantine/core";
import { ViewerContext } from "./ViewerContext";

interface DevSettingsPanelProps {
  devSettingsStore: ReturnType<
    typeof import("./DevSettingsStore").useDevSettingsStore
  >;
}

export function DevSettingsPanel({ devSettingsStore }: DevSettingsPanelProps) {
  const viewer = React.useContext(ViewerContext)!;

  const showStats = devSettingsStore((state) => state.showStats);
  const showLogo = viewer.useGui((state) => state.theme.show_logo);
  const fixedDpr = devSettingsStore((state) => state.fixedDpr);
  const logCamera = devSettingsStore((state) => state.logCamera);
  const enableOrbitCrosshair = devSettingsStore(
    (state) => state.enableOrbitCrosshair,
  );

  const darkMode = viewer.useGui((state) => state.theme.dark_mode);
  const setDarkMode = (dark: boolean) => {
    viewer.useGui.set({
      theme: { ...viewer.useGui.get().theme, dark_mode: dark },
    });
  };
  const setShowLogo = (showLogo: boolean) => {
    viewer.useGui.set({
      theme: { ...viewer.useGui.get().theme, show_logo: showLogo },
    });
  };

  return (
    <Paper withBorder p="xs">
      <Stack gap="xs">
        <Switch
          radius="xs"
          label="Dark Mode"
          checked={darkMode}
          onChange={(event) => setDarkMode(event.currentTarget.checked)}
          size="xs"
        />

        <Switch
          radius="xs"
          label="WebGL Stats"
          checked={showStats}
          onChange={(event) =>
            devSettingsStore.set({
              showStats: event.currentTarget.checked,
            })
          }
          size="xs"
        />

        <Switch
          radius="xs"
          label="Show Viser Logo"
          checked={showLogo}
          onChange={(event) => setShowLogo(event.currentTarget.checked)}
          size="xs"
        />

        <Tooltip
          label={
            <>
              Log camera position and orientation to the
              <br />
              Javascript console.
            </>
          }
          refProp="rootRef"
        >
          <Switch
            radius="xs"
            label="Log Camera to Console"
            checked={logCamera}
            onChange={(event) =>
              devSettingsStore.set({
                logCamera: event.currentTarget.checked,
              })
            }
            size="xs"
          />
        </Tooltip>

        <Tooltip
          label={
            <>
              Show crosshair at look-at point
              <br />
              when moving camera.
            </>
          }
          refProp="rootRef"
        >
          <Switch
            radius="xs"
            label="Show Orbit Crosshair"
            checked={enableOrbitCrosshair}
            onChange={(event) =>
              devSettingsStore.set({
                enableOrbitCrosshair: event.currentTarget.checked,
              })
            }
            size="xs"
          />
        </Tooltip>

        <Tooltip
          label={
            <>
              Device pixel ratio for rendering.
              <br />
              Default (adaptive) behavior dynamically
              <br />
              reduces resolution to maintain framerates.
            </>
          }
        >
          <Select
            label="Device Pixel Ratio"
            placeholder="Adaptive"
            value={fixedDpr?.toString() ?? ""}
            onChange={(value) =>
              devSettingsStore.set({
                fixedDpr: value ? parseFloat(value) : null,
              })
            }
            data={[
              { value: "", label: "Adaptive" },
              { value: "0.5", label: "0.5" },
              { value: "1", label: "1.0" },
              { value: "1.5", label: "1.5" },
              { value: "2", label: "2.0" },
            ]}
            size="xs"
            radius="xs"
            clearable={false}
          />
        </Tooltip>
      </Stack>
    </Paper>
  );
}
