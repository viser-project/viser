import { useDisclosure } from "@mantine/hooks";
import GeneratedGuiContainer, {
  GuiComponentContextProvider,
} from "./Generated";
import { ViewerContext } from "../ViewerContext";

import QRCode from "react-qr-code";
import ServerControls from "./ServerControls";
import { useStableTabSelection } from "../components/TabGroup";
import { GuiComponentContext } from "./GuiComponentContext";
import { GuiDockContext } from "./GuiDockContext";
import { DockContext } from "../dock/DockContext";
import { shallowObjectKeysEqual } from "../utils/shallowObjectKeysEqual";
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
  Tabs,
  Text,
  TextInput,
  Tooltip,
  Transition,
  useMantineColorScheme,
} from "@mantine/core";
import {
  IconAdjustments,
  IconPlayerPause,
  IconCloudCheck,
  IconArrowBack,
  IconShare,
  IconCopy,
  IconCheck,
  IconChevronRight,
  IconPlugConnectedX,
  IconQrcode,
  IconQrcodeOff,
  IconListSearch,
} from "@tabler/icons-react";
import { spotlight } from "@mantine/spotlight";
import { isMac } from "../utils/platform";
import React from "react";
import BottomPanel from "./BottomPanel";
import type { GuiPanelMessage } from "../WebsocketMessages";

// Must match constant in Python.
const ROOT_CONTAINER_ID = "root";

const MemoizedGeneratedGuiContainer = React.memo(GeneratedGuiContainer);

/** True when the root container has any inline generated GUI to show. Standalone
 * panels are a separate top-level entity (never in the root set), so they don't
 * affect this. */
function useShowGenerated(): boolean {
  const viewer = React.useContext(ViewerContext)!;
  return viewer.useGui(
    (state) =>
      Object.keys(state.guiUuidSetFromContainerUuid["root"] ?? {}).length > 0,
  );
}

/** One standalone panel as a collapsible SECTION of the mobile bottom sheet
 * (D45): ONE identity row, two states (P13: the bar is the header with the
 * body removed; P9: identity never renders twice). Collapsed: dimmed tab
 * labels + first icon, chevron at the right end, the whole row a tap target.
 * Expanded, single-tab panel: the header stays as-is and the tab's content
 * renders below WITHOUT a tab strip (the header is the identity). Expanded,
 * multi-tab panel: the REAL tab strip takes over the header row (tabs
 * activate on tap; the chevron at the right end is the collapse control).
 * Panels start COLLAPSED: on a small screen the sheet is wayfinding chrome,
 * and one tap opens the panel you came for. */
function MobilePanelSection({ panel }: { panel: GuiPanelMessage }) {
  const { GuiContainer } = React.useContext(GuiComponentContext)!;
  const [expanded, setExpanded] = React.useState(false);
  const labels = panel.props._tab_labels;
  const icons = panel.props._tab_icons_html;
  const ids = panel.props._tab_container_ids;
  const [activeTab, setActiveTab] = useStableTabSelection(ids);
  const multiTab = ids.length > 1;
  const stripInHeader = expanded && multiTab;

  const chevron = (
    <Box
      onClick={
        // While the strip owns the header, tab taps must not toggle the
        // section -- the chevron alone collapses (its own click target).
        stripInHeader
          ? (ev) => {
              ev.stopPropagation();
              setExpanded(false);
            }
          : undefined
      }
      role={stripInHeader ? "button" : undefined}
      aria-label={stripInHeader ? `Collapse panel ${labels[0] ?? ""}` : undefined}
      style={{
        display: "flex",
        alignItems: "center",
        alignSelf: "center",
        padding: stripInHeader ? "0.5em" : 0,
        cursor: "pointer",
        flexShrink: 0,
      }}
    >
      <IconChevronRight
        size="1em"
        aria-hidden
        style={{
          opacity: 0.55,
          transform: expanded ? "rotate(90deg)" : "none",
          transition: "transform 160ms",
        }}
      />
    </Box>
  );

  return (
    <Tabs
      radius="xs"
      value={activeTab}
      onChange={setActiveTab}
      style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}
    >
      {stripInHeader ? (
        <Box style={{ display: "flex", alignItems: "stretch" }}>
          <Tabs.List style={{ flexGrow: 1 }}>
            {labels.map((label, index) => (
              <Tabs.Tab
                value={ids[index]}
                key={ids[index]}
                styles={{
                  tabSection: { marginRight: "0.5em" },
                  tab: { padding: "0.75em" },
                }}
                leftSection={
                  icons[index] === null ? undefined : (
                    <Box
                      style={{ width: "1em", height: "1em", display: "flex" }}
                      dangerouslySetInnerHTML={{ __html: icons[index]! }}
                    />
                  )
                }
              >
                {label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          {chevron}
        </Box>
      ) : (
        <Box
          onClick={() => setExpanded((e) => !e)}
          role="button"
          aria-expanded={expanded}
          aria-label={`${expanded ? "Collapse" : "Expand"} panel ${
            labels[0] ?? ""
          }`}
          tabIndex={0}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
              ev.preventDefault();
              setExpanded((e) => !e);
            }
          }}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5em",
            minHeight: "2em",
            padding: "0 0.75em",
            cursor: "pointer",
          }}
        >
          {icons.find((h) => h !== null) != null && (
            <Box
              style={{
                display: "flex",
                alignItems: "center",
                opacity: expanded ? 1 : 0.55,
                // Tab icons arrive as sanitized SVG html (same source the
                // tab strip renders).
                width: "1em",
                height: "1em",
              }}
              dangerouslySetInnerHTML={{
                __html: icons.find((h) => h !== null)!,
              }}
            />
          )}
          <Text
            size="sm"
            style={{
              flexGrow: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              opacity: expanded ? 1 : 0.55,
            }}
          >
            {labels.join(" · ")}
          </Text>
          {chevron}
        </Box>
      )}
      <Collapse in={expanded}>
        {multiTab ? (
          ids.map((containerUuid) => (
            <Tabs.Panel value={containerUuid} key={containerUuid}>
              <GuiContainer containerUuid={containerUuid} />
            </Tabs.Panel>
          ))
        ) : ids.length === 1 ? (
          // Single tab: the header IS the identity -- no tab strip (P9).
          <GuiContainer containerUuid={ids[0]} />
        ) : null}
      </Collapse>
    </Tabs>
  );
}

/** Standalone panels rendered as an ACCORDION of bar-like sections, for
 * chromes with no dock surface (the mobile bottom sheet, D45). On the desktop
 * dock surface, panels are placed as their own dock groups by
 * StandalonePanelSync instead; here they would otherwise be invisible (they
 * are not part of the root GUI tree). Hidden panels are skipped (visible is
 * honored on this path too); sections sort by the server-side order. */
function PanelsFallback() {
  const viewer = React.useContext(ViewerContext)!;
  const panels = viewer.useGui((state) => state.panels, shallowObjectKeysEqual);
  // On the dock surface, StandalonePanelSync places panels as dock groups -- so
  // this inline fallback must NOT also render them (that would double-render).
  const dockCtx = React.useContext(DockContext);
  const guiDockCtx = React.useContext(GuiDockContext);
  if (dockCtx !== null && guiDockCtx !== null) return null;
  const shown = Object.values(panels)
    .filter((p) => p.props.visible)
    .sort((a, b) => a.props.order - b.props.order);
  if (shown.length === 0) return null;
  return (
    <GuiComponentContextProvider>
      {shown.map((panel) => (
        <MobilePanelSection key={panel.uuid} panel={panel} />
      ))}
    </GuiComponentContextProvider>
  );
}

/** The control panel's body: server controls / generated GUI, toggled by the
 * settings button in the handle. Shared by every panel chrome (bottom sheet,
 * sidebar, and the dock-library floating panel). */
export function ControlPanelContents({
  showSettings,
}: {
  showSettings: boolean;
}) {
  const showGenerated = useShowGenerated();
  return (
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
      {!showSettings && <PanelsFallback />}
    </>
  );
}

/** Handle button toggling between the generated GUI and the configuration /
 * diagnostics view. Hidden until there is generated GUI to return to. */
export function SettingsToggleIcon({
  showSettings,
  onToggle,
}: {
  showSettings: boolean;
  onToggle: () => void;
}) {
  const showGenerated = useShowGenerated();
  return (
    <ActionIcon
      onClick={(evt) => {
        evt.stopPropagation();
        onToggle();
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
}

export default function ControlPanel() {
  const [showSettings, { toggle }] = useDisclosure(false);

  const generatedServerToggleButton = (
    <SettingsToggleIcon showSettings={showSettings} onToggle={toggle} />
  );

  const panelContents = <ControlPanelContents showSettings={showSettings} />;

  // The "floating" control layout never reaches this component -- App renders it
  // on the docking surface (see ControlPanelDock.tsx). This component is now the
  // mobile bottom sheet only: App only mounts it when not in the floating dock
  // layout, which (since `control_layout` always resolves to "floating") happens
  // exclusively on the mobile breakpoint. The old desktop sidebar layouts
  // (`collapsible`/`fixed`) were removed when `control_layout` was deprecated in
  // favor of `main_panel` placement.
  return (
    <BottomPanel>
      <BottomPanel.Handle>
        <ConnectionStatus />
        <BottomPanel.HideWhenCollapsed>
          <CommandsButton />
          <ShareButton />
          {generatedServerToggleButton}
        </BottomPanel.HideWhenCollapsed>
      </BottomPanel.Handle>
      <BottomPanel.Contents>{panelContents}</BottomPanel.Contents>
    </BottomPanel>
  );
}

/* Icon and label telling us the current status of the websocket connection. */
export function ConnectionStatus() {
  const { useGui } = React.useContext(ViewerContext)!;
  const websocketState = useGui((state) => state.websocketState);
  const label = useGui((state) => state.label);

  return (
    <>
      {/* Spacer reserving room for the absolutely-positioned status icon (which
      crossfades between the connected/reconnecting/inactive variants in this
      spot), plus a small gap before the label. */}
      <div style={{ width: "1.25em", flexShrink: 0 }} />
      <div style={{ width: "0.4em", flexShrink: 0 }} />
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
      <Box
        pr="xs"
        pt="0.1em"
        style={{
          flexGrow: 1,
          letterSpacing: "-0.5px",
          // Truncate instead of wrapping/pushing the action icons off the edge
          // when the panel is narrow. minWidth:0 lets the flex item shrink below
          // its content width.
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
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

export function CommandsButton() {
  const viewer = React.useContext(ViewerContext)!;
  const hasCommands = viewer.useGui(
    (state) => Object.keys(state.commands).length > 0,
  );

  if (!hasCommands) return null;

  return (
    <Tooltip
      zIndex={100}
      label={`Commands (${isMac ? "Cmd" : "Ctrl"}+K)`}
      withinPortal
    >
      <ActionIcon
        onClick={(evt) => {
          evt.stopPropagation();
          spotlight.open();
        }}
        style={{
          transform: "translateY(0.05em)",
        }}
      >
        <IconListSearch stroke={2} height="1.3em" width="1.3em" />
      </ActionIcon>
    </Tooltip>
  );
}

export function ShareButton() {
  const viewer = React.useContext(ViewerContext)!;
  const viewerMutable = viewer.mutable.current; // Get mutable once.
  const connected = viewer.useGui(
    (state) => state.websocketState === "connected",
  );
  const shareUrl = viewer.useGui((state) => state.shareUrl);
  const setShareUrl = viewer.guiActions.setShareUrl;

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
  }, [connected, shareModalOpened, closeShareModal]);

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
          <IconShare stroke={2.25} height="1.125em" width="1.125em" />
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
