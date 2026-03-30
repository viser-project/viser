import { ViewerContext } from "../ViewerContext";
import {
  Box,
  Button,
  Image,
  Checkbox,
  Divider,
  Group,
  Stack,
  Text,
  TextInput,
  Tooltip,
  Collapse,
} from "@mantine/core";
import { IconHomeMove, IconPhoto } from "@tabler/icons-react";
import React from "react";

// Import logo as asset for proper bundling/inlining.
import logoSvg from "../assets/logo.svg";
import SceneTreeTable from "./SceneTreeTable";
import { DevSettingsPanel } from "../DevSettingsPanel";

const MemoizedTable = React.memo(SceneTreeTable);

export default function ServerControls() {
  const viewer = React.useContext(ViewerContext)!;
  const viewerMutable = viewer.mutable.current; // Get mutable once
  const controlWidth = viewer.useGui((state) => state.theme.control_width);
  const [showDevSettings, setShowDevSettings] = React.useState(false);

  return (
    <>
      <Stack gap="xs" mt="0.3em">
        <Tooltip label="Server URL" position="top-start">
          <TextInput
            leftSection={
              <Image
                src={logoSvg}
                style={{
                  width: "1rem",
                  height: "auto",
                  filter: "grayscale(100%) opacity(0.3)",
                }}
              />
            }
            leftSectionWidth="1.8rem"
            defaultValue={viewer.useGui((state) => state.server)}
            onBlur={(event) =>
              viewer.useGui.set({ server: event.currentTarget.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
                event.currentTarget.focus();
              }
            }}
          />
        </Tooltip>
        <Group gap="0.5em">
          <Button
            onClick={async () => {
              const supportsFileSystemAccess =
                "showSaveFilePicker" in window &&
                (() => {
                  try {
                    return window.self === window.top;
                  } catch {
                    return false;
                  }
                })();

              if (supportsFileSystemAccess) {
                // File System Access API is supported. (eg Chrome)
                const fileHandlePromise = window.showSaveFilePicker({
                  suggestedName: "render.png",
                  types: [
                    {
                      accept: { "image/png": [".png"] },
                    },
                  ],
                });
                viewerMutable.canvas?.toBlob(async (blob) => {
                  if (blob === null) {
                    console.error("Export failed");
                    return;
                  }

                  const handle = await fileHandlePromise;
                  const writableStream = await handle.createWritable();
                  await writableStream.write(blob);
                  await writableStream.close();
                });
              } else {
                // File System Access API is not supported. (eg Firefox)
                viewerMutable.canvas?.toBlob((blob) => {
                  if (blob === null) {
                    console.error("Export failed");
                    return;
                  }
                  const href = URL.createObjectURL(blob);

                  // Download a file by creating a link and then clicking it.
                  const link = document.createElement("a");
                  link.href = href;
                  const filename = "render.png";
                  link.download = filename;
                  document.body.appendChild(link);
                  link.click();
                  document.body.removeChild(link);
                  URL.revokeObjectURL(href);
                });
              }
            }}
            flex={1}
            leftSection={
              controlWidth === "small" ? undefined : <IconPhoto size="1rem" />
            }
            px="0"
            style={{ height: "1.875rem" }}
          >
            Save Canvas
          </Button>
          <Button
            onClick={() => {
              viewerMutable.resetCameraPose!(true);
            }}
            flex={1}
            leftSection={
              controlWidth === "small" ? undefined : (
                <IconHomeMove size="1rem" />
              )
            }
            px="0"
            style={{ height: "1.875rem" }}
          >
            Reset View
          </Button>
        </Group>
        <Group gap="md">
          <Tooltip
            label={
              <>
                Show tool for setting the look-at point and
                <br />
                up direction of the camera.
                <br />
                <br />
                This can be used to set the origin of the
                <br />
                camera&apos;s orbit controls.
              </>
            }
            refProp="rootRef"
            position="top-start"
          >
            <Checkbox
              radius="xs"
              label="Orbit Origin Tool"
              onChange={(event) => {
                viewer.useGui.set({
                  showOrbitOriginTool: event.currentTarget.checked,
                });
              }}
              styles={{
                label: { paddingLeft: "8px", letterSpacing: "-0.3px" },
                root: { flex: 1 },
              }}
              size="sm"
            />
          </Tooltip>
          <Checkbox
            radius="xs"
            label="Dev Settings"
            onChange={(event) => {
              setShowDevSettings(event.currentTarget.checked);
            }}
            styles={{
              label: { paddingLeft: "8px", letterSpacing: "-0.3px" },
              root: { flex: 1 },
            }}
            size="sm"
          />
        </Group>
        <Box mt="-0.4em">
          <Collapse in={showDevSettings}>
            <Box mt="0.4em">
              <DevSettingsPanel devSettingsStore={viewer.useDevSettings} />
            </Box>
          </Collapse>
        </Box>
        <Divider />
        <Box>
          <Tooltip
            label={
              <>
                Hierarchical view of all objects in the 3D scene.
                <br />
                Use to override visibility and properties.
              </>
            }
            position="top-start"
          >
            <Text style={{ fontWeight: 500 }} fz="sm">
              Scene tree
            </Text>
          </Tooltip>
          <MemoizedTable />
        </Box>
      </Stack>
    </>
  );
}
