import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import GeneratedGuiContainer from "./Generated";
import { ViewerContext } from "../ViewerContext";

import QRCode from "react-qr-code";
import ServerControls from "./ServerControls";
import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Collapse,
  CopyButton,
  Flex,
  Loader,
  Modal,
  Stack,
  Text,
  TextInput,
  Tooltip,
  Transition,
  useMantineColorScheme,
  useMantineTheme,
} from "@mantine/core";
import {
  IconAdjustments,
  IconPlayerPause,
  IconCloudCheck,
  IconArrowBack,
  IconShare,
  IconCopy,
  IconCheck,
  IconPlugConnectedX,
  IconQrcode,
  IconQrcodeOff,
} from "@tabler/icons-react";
import React from "react";
import BottomPanel from "./BottomPanel";
import FloatingPanel from "./FloatingPanel";
import { ThemeConfigurationMessage } from "../WebsocketMessages";
import SidebarPanel from "./SidebarPanel";

// Must match constant in Python.
const ROOT_CONTAINER_ID = "root";

const MemoizedGeneratedGuiContainer = React.memo(GeneratedGuiContainer);

export default function ControlPanel(props: {
  control_layout: ThemeConfigurationMessage["control_layout"];
}) {
  const theme = useMantineTheme();
  const useMobileView = useMediaQuery(`(max-width: ${theme.breakpoints.xs})`);

  // TODO: will result in unnecessary re-renders.
  const viewer = React.useContext(ViewerContext)!;
  const showGenerated = viewer.useGui(
    (state) =>
      Object.keys(state.guiUuidSetFromContainerUuid["root"] ?? {}).length > 0,
  );
  const [showSettings, { toggle }] = useDisclosure(false);

  const controlWidthString = viewer.useGui(
    (state) => state.theme.control_width,
  );
  const controlWidth = (
    controlWidthString == "small"
      ? "16em"
      : controlWidthString == "medium"
        ? "20em"
        : controlWidthString == "large"
          ? "24em"
          : null
  )!;

  const generatedServerToggleButton = (
    <ActionIcon
      onClick={(evt) => {
        evt.stopPropagation();
        toggle();
      }}
      style={{
        display: showGenerated ? undefined : "none",
        transform: "translateY(0.05em)",
      }}
    >
      <Tooltip
        zIndex={100}
        label={showSettings ? "Return to GUI" : "Configuration & diagnostics"}
        withinPortal
      >
        {showSettings ? (
          <IconArrowBack stroke={1.625} />
        ) : (
          <IconAdjustments stroke={1.625} />
        )}
      </Tooltip>
    </ActionIcon>
  );

  const panelContents = (
    <>
      <Collapse in={!showGenerated || showSettings}>
        <Box p="xs" pt="0.375em">
          <ServerControls />
        </Box>
      </Collapse>
      {/*As of Mantine 8.3.3, this `keepMounted` is necessary to prevent some
      intermittent problems with the initial GUI height being set to 0 when
      we're under high CPU load.*/}
      <Collapse in={showGenerated && !showSettings} keepMounted>
        <MemoizedGeneratedGuiContainer containerUuid={ROOT_CONTAINER_ID} />
      </Collapse>
    </>
  );

  if (useMobileView) {
    /* Mobile layout. */
    return (
      <BottomPanel>
        <BottomPanel.Handle>
          <ConnectionStatus />
          <BottomPanel.HideWhenCollapsed>
            <ShareButton />
            {generatedServerToggleButton}
          </BottomPanel.HideWhenCollapsed>
        </BottomPanel.Handle>
        <BottomPanel.Contents>{panelContents}</BottomPanel.Contents>
      </BottomPanel>
    );
  } else if (props.control_layout === "floating") {
    /* Floating layout. */
    return (
      <FloatingPanel width={controlWidth}>
        <FloatingPanel.Handle>
          <ConnectionStatus />
          <FloatingPanel.HideWhenCollapsed>
            <ShareButton />
            {generatedServerToggleButton}
          </FloatingPanel.HideWhenCollapsed>
        </FloatingPanel.Handle>
        <FloatingPanel.Contents>{panelContents}</FloatingPanel.Contents>
      </FloatingPanel>
    );
  } else {
    /* Sidebar view. */
    return (
      <SidebarPanel
        width={controlWidth}
        collapsible={props.control_layout === "collapsible"}
      >
        <SidebarPanel.Handle>
          <ConnectionStatus />
          <ShareButton />
          {generatedServerToggleButton}
        </SidebarPanel.Handle>
        <SidebarPanel.Contents>{panelContents}</SidebarPanel.Contents>
      </SidebarPanel>
    );
  }
}

/* Icon and label telling us the current status of the websocket connection. */
function ConnectionStatus() {
  const { useGui } = React.useContext(ViewerContext)!;
  const websocketState = useGui((state) => state.websocketState);
  const label = useGui((state) => state.label);

  return (
    <>
      <div style={{ width: "1.1em" }} /> {/* Spacer. */}
      <Transition transition="fade" mounted={websocketState === "connected"}>
        {(styles) => (
          <IconCloudCheck
            color={"#0b0"}
            style={{
              position: "absolute",
              width: "1.25em",
              height: "1.25em",
              ...styles,
            }}
          />
        )}
      </Transition>
      <Transition
        transition="skew-down"
        mounted={websocketState === "reconnecting"}
      >
        {(styles) => (
          <Loader
            size="xs"
            type="dots"
            color="red"
            style={{ position: "absolute", ...styles }}
          />
        )}
      </Transition>
      <Transition
        transition="skew-down"
        mounted={websocketState === "inactive"}
      >
        {(styles) => (
          <IconPlayerPause
            color={"var(--mantine-color-red-filled)"}
            style={{
              position: "absolute",
              width: "1.25em",
              height: "1.25em",
              ...styles,
            }}
          />
        )}
      </Transition>
      <Box px="xs" style={{ flexGrow: 1, letterSpacing: "-0.5px" }} pt="0.1em">
        {label !== ""
          ? label
          : websocketState === "connected"
            ? "Connected"
            : websocketState === "reconnecting"
              ? "Connecting..."
              : "Inactive"}
      </Box>
    </>
  );
}

function ShareButton() {
  const viewer = React.useContext(ViewerContext)!;
  const viewerMutable = viewer.mutable.current; // Get mutable once.
  const connected = viewer.useGui(
    (state) => state.websocketState === "connected",
  );
  const shareUrl = viewer.useGui((state) => state.shareUrl);
  const setShareUrl = viewer.useGui((state) => state.setShareUrl);

  const [doingSomething, setDoingSomething] = React.useState(false);

  const [shareModalOpened, { open: openShareModal, close: closeShareModal }] =
    useDisclosure(false);

  const [showQrCode, { toggle: toggleShowQrcode }] = useDisclosure();

  // Turn off loader when share URL is set.
  React.useEffect(() => {
    if (shareUrl !== null) {
      setDoingSomething(false);
    }
  }, [shareUrl]);
  React.useEffect(() => {
    if (!connected && shareModalOpened) closeShareModal();
  }, [connected, shareModalOpened]);

  const colorScheme = useMantineColorScheme().colorScheme;

  if (viewer.useGui((state) => state.theme).show_share_button === false)
    return null;

  return (
    <>
      <Tooltip
        zIndex={100}
        label={connected ? "Share" : "Share (needs connection)"}
        withinPortal
      >
        <ActionIcon
          onClick={(evt) => {
            evt.stopPropagation();
            openShareModal();
          }}
          style={{
            transform: "translateY(0.05em)",
          }}
          disabled={!connected}
        >
          <IconShare stroke={2} height="1.125em" width="1.125em" />
        </ActionIcon>
      </Tooltip>
      <Modal
        title="Share"
        opened={shareModalOpened}
        onClose={closeShareModal}
        withCloseButton={false}
        zIndex={100}
        withinPortal
        onClick={(evt) => evt.stopPropagation()}
        onMouseDown={(evt) => evt.stopPropagation()}
        onMouseMove={(evt) => evt.stopPropagation()}
        onMouseUp={(evt) => evt.stopPropagation()}
        styles={{ title: { fontWeight: 600 } }}
      >
        {shareUrl === null ? (
          <>
            {/*<Select
                label="Server"
                data={["viser-us-west (https://share.viser.studio)"]}
                withinPortal
                {...form.getInputProps("server")}
              /> */}
            {doingSomething ? (
              <Stack mb="xl">
                <Loader size="xl" mx="auto" type="dots" />
              </Stack>
            ) : (
              <Stack mb="md">
                <Text>
                  Create a public, shareable URL to this Viser instance.
                </Text>
                <Button
                  fullWidth
                  onClick={() => {
                    viewerMutable.sendMessage({
                      type: "ShareUrlRequest",
                    });
                    setDoingSomething(true); // Loader state will help with debouncing.
                  }}
                >
                  Request Share URL
                </Button>
              </Stack>
            )}
          </>
        ) : (
          <>
            <Text>Share URL is connected.</Text>
            <Stack gap="xs" my="md">
              <TextInput value={shareUrl} />
              <Flex justify="space-between" columnGap="0.5em" align="center">
                <CopyButton value={shareUrl}>
                  {({ copied, copy }) => (
                    <Button
                      style={{ width: "50%" }}
                      leftSection={
                        copied ? (
                          <IconCheck height="1.375em" width="1.375em" />
                        ) : (
                          <IconCopy height="1.375em" width="1.375em" />
                        )
                      }
                      onClick={copy}
                      variant={copied ? "outline" : "filled"}
                    >
                      {copied ? "Copied!" : "Copy URL"}
                    </Button>
                  )}
                </CopyButton>
                <Button
                  style={{ flexGrow: 1 }}
                  leftSection={showQrCode ? <IconQrcodeOff /> : <IconQrcode />}
                  onClick={toggleShowQrcode}
                >
                  QR Code
                </Button>
                <Tooltip zIndex={100} label="Disconnect" withinPortal>
                  <Button
                    color="red"
                    onClick={() => {
                      viewerMutable.sendMessage({
                        type: "ShareUrlDisconnect",
                      });
                      setShareUrl(null);
                    }}
                  >
                    <IconPlugConnectedX />
                  </Button>
                </Tooltip>
              </Flex>
              <Collapse in={showQrCode}>
                <QRCode
                  value={shareUrl}
                  fgColor={colorScheme === "dark" ? "#ffffff" : "#000000"}
                  bgColor="rgba(0,0,0,0)"
                  level="M"
                  style={{
                    width: "100%",
                    height: "auto",
                    margin: "1em auto 0 auto",
                  }}
                />
              </Collapse>
            </Stack>
          </>
        )}
        <Text size="xs">
          Share links are experimental and bandwidth-limited. Problems? Consider{" "}
          <Anchor href="https://github.com/viser-project/viser/issues">
            reporting on GitHub
          </Anchor>
          .
        </Text>
      </Modal>
    </>
  );
}
