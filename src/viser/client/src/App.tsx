// @refresh reset
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
import "./App.css";
import "./index.css";

import { useInView } from "react-intersection-observer";
import { Notifications } from "@mantine/notifications";
import { PerformanceMonitor, Stats } from "@react-three/drei";
import { HDRJPGEnvironment } from "./HDRJPGEnvironment";
import * as THREE from "three";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import React, { useEffect, useMemo } from "react";
import { ViewerMutable } from "./ViewerContext";
import { InteractionController } from "./pointer/interactionController";
import {
  Anchor,
  Box,
  Divider,
  Image,
  MantineProvider,
  Modal,
  Tooltip,
  createTheme,
  useMantineColorScheme,
  useMantineTheme,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";

// Local imports.
import { SynchronizedCameraControls } from "./CameraControls";
import { SceneNodeThreeObject } from "./SceneTree";
import { DragLayer } from "./DragLayer";
import { KeyModifier, hasCmdCtrl, keyModifierFromEvent } from "./dragUtils";
import { shallowArrayEqual } from "./utils/shallowArrayEqual";
import { isFormElement } from "./utils/isFormElement";
import { ndcFromPointerXy, opencvXyFromPointerXy } from "./utils/pointerCoords";
import { ViewerContext, ViewerContextContents } from "./ViewerContext";
import ControlPanel from "./ControlPanel/ControlPanel";
import {
  ControlDockState,
  ControlPanelDockSurface,
} from "./ControlPanel/ControlPanelDock";
import { useGuiState } from "./ControlPanel/GuiState";
import { searchParamKey } from "./SearchParamsUtils";
import { WebsocketMessageProducer } from "./WebsocketInterface";
import { Titlebar } from "./Titlebar";
import { ViserModal } from "./Modal";
import { CommandPalette } from "./CommandPalette";
import { useSceneTreeState } from "./SceneTreeState";
import { useEnvironmentState } from "./EnvironmentState";
import { useDevSettingsStore } from "./DevSettingsStore";
import { useInitialCameraState } from "./InitialCameraState";
import { useThrottledMessageSender } from "./WebsocketUtils";
import { rayToViserCoords } from "./WorldTransformUtils";
import { theme } from "./AppTheme";
import { FrameSynchronizedMessageHandler } from "./MessageHandler";
import { PlaybackFromFile, PlaybackFromEmbedData } from "./FilePlayback";
import { SplatRenderContext } from "./Splatting/GaussianSplats";
import { BrowserWarning } from "./BrowserWarning";
import { MacWindowWrapper } from "./MacWindowWrapper";
import { CsmDirectionalLight } from "./CsmDirectionalLight";
import { VISER_VERSION, GITHUB_CONTRIBUTORS, Contributor } from "./VersionInfo";
import { BatchedLabelManager } from "./BatchedLabelManager";

// Import logo as asset for proper bundling/inlining.
import logoSvg from "./assets/logo.svg";

// Import HDRI files as assets for proper bundling/inlining.
// These are HDR JPEG (gainmap) format files that are ~10x smaller than traditional HDR.
import hdriApartment from "./assets/lebombo_1k.jpg";
import hdriCity from "./assets/potsdamer_platz_1k.jpg";
import hdriDawn from "./assets/kiara_1_dawn_1k.jpg";
import hdriForest from "./assets/forest_slope_1k.jpg";
import hdriLobby from "./assets/st_fagans_interior_1k.jpg";
import hdriNight from "./assets/dikhololo_night_1k.jpg";
import hdriPark from "./assets/rooitou_park_1k.jpg";
import hdriStudio from "./assets/studio_small_03_1k.jpg";
import hdriSunset from "./assets/venice_sunset_1k.jpg";
import hdriWarehouse from "./assets/empty_warehouse_01_1k.jpg";

// Map preset names to imported HDRI assets.
const hdriPresets: Record<string, string> = {
  apartment: hdriApartment,
  city: hdriCity,
  dawn: hdriDawn,
  forest: hdriForest,
  lobby: hdriLobby,
  night: hdriNight,
  park: hdriPark,
  studio: hdriStudio,
  sunset: hdriSunset,
  warehouse: hdriWarehouse,
};

// ======= Utility functions =======

/** Gets default WebSocket server URL based on current window location. */
const getDefaultServerFromUrl = (): string => {
  let server = window.location.href;
  server = server.replace("http://", "ws://");
  server = server.replace("https://", "wss://");
  server = server.split("?")[0];
  if (server.endsWith("/")) server = server.slice(0, -1);
  return server;
};

/** Disables rendering when component is not in view. */
const DisableRender = (): null => useFrame(() => null, 1000);

// ======= Main component tree =======

/**
 * Root application component - handles dummy window wrapper if needed.
 */
export function Root() {
  const searchParams = new URLSearchParams(window.location.search);
  const dummyWindowParam = searchParams.get("dummyWindowDimensions");
  const dummyWindowTitle =
    searchParams.get("dummyWindowTitle") ?? "localhost:8080";

  const content = (
    <div
      style={{
        width: "100%",
        height: "100%",
        position: "relative",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <ViewerRoot />
    </div>
  );

  // If dummy window dimensions are specified, wrap content in MacWindowWrapper.
  if (!dummyWindowParam) return content;

  // Handle "fill" flag to make window full size.
  if (dummyWindowParam === "fill") {
    return (
      <MacWindowWrapper
        title={dummyWindowTitle}
        width={window.innerWidth}
        height={window.innerHeight}
        fill={true}
      >
        {content}
      </MacWindowWrapper>
    );
  }

  const [width, height] = dummyWindowParam.split("x").map(Number);
  if (isNaN(width) || isNaN(height)) return content;

  return (
    <MacWindowWrapper title={dummyWindowTitle} width={width} height={height}>
      {content}
    </MacWindowWrapper>
  );
}

/**
 * Main viewer context provider component.
 */
function ViewerRoot() {
  // Server configuration and URL parameters.
  const servers = new URLSearchParams(window.location.search).getAll(
    searchParamKey,
  );
  const initialServer =
    servers.length >= 1 ? servers[0] : getDefaultServerFromUrl();

  const searchParams = new URLSearchParams(window.location.search);
  const playbackPath = searchParams.get("playbackPath");

  // Check for embedded scene data via window global.
  const embedData = (window as any).__VISER_EMBED_DATA__ as string | undefined;
  const embedConfig = (window as any).__VISER_EMBED_CONFIG__ as
    { darkMode?: boolean } | undefined;
  const darkMode = searchParams.get("darkMode") !== null;

  // Create a message source string.
  const messageSource = embedData
    ? "embed"
    : playbackPath === null
      ? "websocket"
      : "file_playback";

  // Create a single ref with all mutable state.
  const nodeRefFromName = {};
  const mutable = React.useRef<ViewerMutable>({
    // Function references with default implementations.
    sendMessage:
      messageSource === "websocket"
        ? (message: any) =>
            console.log(
              `Tried to send ${message.type} but websocket is not connected!`,
            )
        : () => null,
    sendCamera: null,
    resetCameraPose: null,
    syncCanvasSize: null,

    // DOM/Three.js references.
    canvas: null,
    canvas2d: null,
    scene: null,
    camera: null,
    backgroundMaterial: null,
    cameraControl: null,

    // Scene management.
    nodeRefFromName,

    // Message and rendering state.
    messageQueue: [],
    firstMessageBatch: true,
    getRenderRequestState: "ready",
    getRenderRequest: null,
    initialCameraDiagnostic: null,

    // Skinned mesh state.
    skinnedMeshState: {},

    // Per-node pose data (non-reactive, read in useFrame).
    nodePoseData: {},
  });

  const interaction = React.useMemo(
    () =>
      new InteractionController({
        getCameraControl: () => mutable.current.cameraControl,
        getCanvas: () => mutable.current.canvas,
      }),
    [],
  );

  // Create the scene tree state and extract store and actions.
  const sceneTreeState = useSceneTreeState(
    mutable.current.nodeRefFromName,
    mutable.current.nodePoseData,
  );

  // Create the environment state and extract store and actions.
  const environmentState = useEnvironmentState();

  // Create the dev settings store.
  const devSettingsStore = useDevSettingsStore();

  // Create the initial camera store with URL params.
  const initialCameraState = useInitialCameraState(
    // Parse URL params once during initialization.
    React.useMemo(() => {
      // Helper to parse and validate a vector URL param.
      const parseVec3 = (param: string): [number, number, number] | null => {
        const str = searchParams.get(param);
        if (str === null) return null;
        const parts = str.split(",").map(Number);
        if (parts.length !== 3 || !parts.every(Number.isFinite)) return null;
        return parts as [number, number, number];
      };
      // Helper to parse and validate a scalar URL param.
      const parseScalar = (param: string): number | null => {
        const str = searchParams.get(param);
        if (str === null) return null;
        const val = Number(str);
        return Number.isFinite(val) ? val : null;
      };
      return {
        position: parseVec3("initialCameraPosition"),
        lookAt: parseVec3("initialCameraLookAt"),
        up: parseVec3("initialCameraUp"),
        fov: parseScalar("initialCameraFov"),
        near: parseScalar("initialCameraNear"),
        far: parseScalar("initialCameraFar"),
      };
    }, []),
  );

  // `?darkMode` / embed darkMode forces dark mode. We OR it into the rendered
  // color scheme in ViewerContents so it (a) wins over a server-sent theme --
  // configure_theme defaults dark_mode=False, which would otherwise override
  // the URL -- and (b) is correct on the very first paint, with no render-phase
  // store write or post-mount flash.
  const effectiveDarkMode = darkMode || embedConfig?.darkMode || false;

  // Create GUI state.
  const guiState = useGuiState(initialServer);

  // Create the context value with hooks and single ref.
  const viewer: ViewerContextContents = {
    messageSource,
    useSceneTree: sceneTreeState.store,
    sceneTreeActions: sceneTreeState.actions,
    useEnvironment: environmentState,
    useGui: guiState.store,
    useGuiConfig: guiState.configStore,
    guiActions: guiState.actions,
    useDevSettings: devSettingsStore,
    useInitialCamera: initialCameraState.store,
    initialCameraActions: initialCameraState.actions,
    mutable,
    interaction,
  };

  return (
    <ViewerContext.Provider value={viewer}>
      <ViewerContents forceDarkMode={effectiveDarkMode}>
        {messageSource === "websocket" && <WebsocketMessageProducer />}
        {messageSource === "file_playback" && (
          <PlaybackFromFile fileUrl={playbackPath!} />
        )}
        {messageSource === "embed" && (
          <PlaybackFromEmbedData base64Data={embedData!} />
        )}
      </ViewerContents>
    </ViewerContext.Provider>
  );
}

/**
 * Main content wrapper with theme and layout.
 */
function ViewerContents({
  children,
  forceDarkMode,
}: {
  children: React.ReactNode;
  forceDarkMode: boolean;
}) {
  const viewer = React.useContext(ViewerContext)!;
  // `?darkMode` / embed darkMode forces dark mode and wins over the server's
  // theme (configure_theme defaults dark_mode=False).
  const storeDarkMode = viewer.useGui((state) => state.theme.dark_mode);
  const darkMode = forceDarkMode || storeDarkMode;
  const colors = viewer.useGui((state) => state.theme.colors);
  const controlLayout = viewer.useGui((state) => state.theme.control_layout);
  const showLogo = viewer.useGui((state) => state.theme.show_logo);
  const showStats = viewer.useDevSettings((state) => state.showStats);
  const { messageSource } = viewer;

  // Create Mantine theme with custom colors if provided.
  const mantineTheme = useMemo(
    () =>
      createTheme({
        ...theme,
        ...(colors === null
          ? {}
          : { colors: { custom: colors }, primaryColor: "custom" }),
      }),
    [colors],
  );
  const canvases = useMemo(
    () => (
      <>
        <Viewer2DCanvas />
        <ViewerCanvas>
          <FrameSynchronizedMessageHandler />
        </ViewerCanvas>
      </>
    ),
    [],
  );
  return (
    <>
      <MantineProvider
        theme={mantineTheme}
        defaultColorScheme={darkMode ? "dark" : "light"}
        colorSchemeManager={{
          // Mock external color scheme manager. This prevents multiple Viser
          // instances from affecting each others' color schemes.
          get: (defaultValue) => defaultValue,
          set: () => null,
          subscribe: () => null,
          unsubscribe: () => null,
          clear: () => null,
        }}
      >
        {children}
        <ColorSchemeSetter darkMode={darkMode} />
        <BrowserWarning />
        <ViserModal />
        <CommandPalette />
        <AppLayout
          darkMode={darkMode}
          controlLayout={controlLayout}
          showLogo={showLogo}
          messageSource={messageSource}
          canvases={canvases}
        />
        {showStats && <Stats className="stats-panel" />}
      </MantineProvider>
    </>
  );
}

/**
 * The app layout below the titlebar: canvas area + control panel. Lives in its
 * own component (inside the MantineProvider) so it can read the theme's mobile
 * breakpoint.
 */
function AppLayout({
  darkMode,
  controlLayout,
  showLogo,
  messageSource,
  canvases,
}: {
  darkMode: boolean;
  controlLayout: "floating" | "collapsible" | "fixed";
  showLogo: boolean;
  messageSource: "websocket" | "file_playback" | "embed";
  canvases: React.ReactNode;
}) {
  const mantineTheme = useMantineTheme();
  const useMobileView =
    useMediaQuery(`(max-width: ${mantineTheme.breakpoints.xs})`) ?? false;
  // The floating layout runs on the docking library: the control panel is a
  // dock panel over the canvas (draggable, dockable to either edge, resizable,
  // minimizable). Sidebar layouts and the mobile bottom sheet are unchanged.
  const dockFloating =
    controlLayout === "floating" &&
    !useMobileView &&
    messageSource === "websocket";

  // Where the control panel sits, reported by the dock surface. `side: null`
  // means it floats freely; a non-null side means it's docked (the dock
  // surface insets the canvas itself -- this state only feeds the
  // notifications offset).
  const [controlDock, setControlDock] = React.useState<ControlDockState>({
    side: null,
    widthPx: 320,
    expanded: true,
    leftRegionWidthPx: 0,
  });
  // Leaving the dock-floating layout (theme switch, mobile resize) unmounts
  // the dock surface; clear any stale dock state so the notifications offset
  // doesn't keep a defunct inset.
  React.useEffect(() => {
    if (!dockFloating) {
      setControlDock((prev) =>
        prev.side === null && prev.leftRegionWidthPx === 0
          ? prev
          : { ...prev, side: null, leftRegionWidthPx: 0 },
      );
    }
  }, [dockFloating]);

  const canvasContent = (
    <>
      {canvases}
      {showLogo && messageSource === "websocket" && <ViserLogo />}
    </>
  );

  return (
    <Box
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        flexDirection: "column",
      }}
    >
      <Titlebar />
      <Box
        style={{
          width: "100%",
          position: "relative",
          flexGrow: 1,
          overflow: "hidden",
          display: "flex",
        }}
      >
        <NotificationsPanel
          dockedLeftInsetPx={
            // Clear the entire left-docked region (control panel OR a standalone
            // panel docked left). 0 when nothing is docked left.
            controlDock.leftRegionWidthPx > 0
              ? controlDock.leftRegionWidthPx
              : null
          }
        />
        <Box
          style={(theme) => ({
            backgroundColor: darkMode ? theme.colors.dark[9] : "#fff",
            overflow: "hidden",
            flexGrow: 1,
            height: "100%",
          })}
        >
          {dockFloating ? (
            <ControlPanelDockSurface onDockStateChange={setControlDock}>
              {canvasContent}
            </ControlPanelDockSurface>
          ) : (
            canvasContent
          )}
        </Box>
        {messageSource === "websocket" && !dockFloating && <ControlPanel />}
      </Box>
    </Box>
  );
}

function ColorSchemeSetter(props: { darkMode: boolean }) {
  const colorScheme = useMantineColorScheme();
  // Update data attribute for color scheme.
  useEffect(() => {
    colorScheme.setColorScheme(props.darkMode ? "dark" : "light");
  }, [props.darkMode]);
  return null;
}

/**
 * Notifications panel with fixed styling.
 */
function NotificationsPanel({
  dockedLeftInsetPx,
}: {
  /** Width of a left-docked, expanded control panel, or null when the
   * top-left is clear. Notifications sit at the top-left; a left-docked panel
   * shifts them right by its width so they appear over the canvas instead of
   * covering the GUI. */
  dockedLeftInsetPx: number | null;
}) {
  return (
    <Notifications
      position="top-left"
      limit={10}
      containerWidth="20em"
      withinPortal={false}
      styles={{
        root: {
          boxShadow: "0.1em 0 1em 0 rgba(0,0,0,0.1) !important",
          position: "absolute",
          top: "1em",
          left:
            dockedLeftInsetPx !== null
              ? `calc(${dockedLeftInsetPx}px + 1em)`
              : "1em",
          pointerEvents: "none",
        },
        notification: {
          pointerEvents: "all",
        },
      }}
    />
  );
}

/**
 * Main 3D canvas component.
 */
function ViewerCanvas({ children }: { children: React.ReactNode }) {
  const viewer = React.useContext(ViewerContext)!;
  const interaction = viewer.interaction;
  const sendClickThrottled = useThrottledMessageSender(20).send;
  const theme = useMantineTheme();
  const { ref: inViewRef, inView } = useInView();

  // Memoize camera controls to prevent unnecessary re-creation.
  const memoizedCameraControls = useMemo(
    () => <SynchronizedCameraControls />,
    [],
  );

  // Render the rect-select overlay onto the canvas2d layer. Called
  // from the pointer handlers when motion in a committed rect-select
  // gesture should repaint. Theme is read at draw time (not captured)
  // so a runtime theme change reflects immediately.
  const drawRectSelectOverlay = React.useCallback(
    (rect: { startXy: [number, number]; endXy: [number, number] } | null) => {
      const c2d = viewer.mutable.current.canvas2d;
      if (c2d === null) return;
      const ctx = c2d.getContext("2d");
      if (ctx === null) return;
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      if (rect === null) return;
      const [sx, sy] = rect.startXy;
      const [ex, ey] = rect.endXy;
      ctx.beginPath();
      ctx.fillStyle = theme.primaryColor;
      ctx.strokeStyle = "blue";
      ctx.globalAlpha = 0.2;
      ctx.fillRect(sx, sy, ex - sx, ey - sy);
      ctx.globalAlpha = 1.0;
      ctx.stroke();
    },
    [theme, viewer],
  );

  const cancelActiveScenePointer = React.useCallback(() => {
    interaction.cancelAny();
    drawRectSelectOverlay(null);
  }, [drawRectSelectOverlay, interaction]);

  // Keep a stable handle to the latest cancel callback. The blur/key effect
  // below must NOT depend on `cancelActiveScenePointer` directly: that callback's
  // identity changes whenever the Mantine theme changes (via
  // `drawRectSelectOverlay`'s `[theme]` dep), and re-running the effect calls
  // `cancelActiveScenePointer()` in its cleanup -- which would abort an in-flight
  // scene-pointer gesture on every theme update.
  const cancelActiveScenePointerRef = React.useRef(cancelActiveScenePointer);
  cancelActiveScenePointerRef.current = cancelActiveScenePointer;

  // Held-modifier tracking. Three sources keep `hoverSet`'s
  // `heldModifier` in sync with reality:
  //   - `keydown`/`keyup`: live updates while the canvas is focused.
  //   - `blur`: drops the modifier; a release out of focus may not
  //     deliver `keyup`.
  //   - `pointermove`: reconciles from the event's modifier flags so
  //     a focus regain with the modifier still held recovers without
  //     waiting for the next keypress.
  React.useEffect(() => {
    const onBlur = () => {
      cancelActiveScenePointerRef.current();
      interaction.hover.setHeldModifier(null);
    };
    const onKey = (e: KeyboardEvent) => {
      // Skip while typing in form controls so Shift in a TextInput
      // doesn't flicker the canvas cursor.
      if (isFormElement(e.target) || isFormElement(document.activeElement)) {
        return;
      }
      interaction.hover.setHeldModifier(keyModifierFromEvent(e));
    };
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      cancelActiveScenePointerRef.current();
    };
  }, [interaction]);

  // Canvas pointer handlers thin-delegate to the gestures module.
  // Side effects (camera lock, overlay draw, wire dispatch) happen
  // here based on the returned outcome.
  const canvasXyFromEvent = React.useCallback(
    (e: React.PointerEvent): [number, number] => {
      const bbox = viewer.mutable.current.canvas!.getBoundingClientRect();
      return [e.clientX - bbox.left, e.clientY - bbox.top];
    },
    [viewer],
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    // If a 3D handle already captured this pointer (drei's orbit-origin /
    // transform gizmos call setPointerCapture on the canvas in their own
    // pointerdown, which runs before this bubbles up), it owns the gesture.
    // Engaging the canvas-level scene-pointer path here would, for a
    // rect-select gesture, call setPointerCapture on a *different* element and
    // steal the gizmo's capture -- R3F then drops it and the gizmo's pointerup
    // is missed, leaving it stuck mid-drag.
    if (viewer.mutable.current.canvas?.hasPointerCapture(e.pointerId)) return;
    const xy = canvasXyFromEvent(e);
    const next = interaction.scenePointer.onPointerDown({
      pointerId: e.pointerId,
      button: e.nativeEvent.button,
      modifier: keyModifierFromEvent(e),
      xy,
      insideViewport: ndcFromPointerXy(viewer, xy) !== null,
    });
    if (next.kind !== "scene-rect-select") return;
    // Capture the pointer so subsequent move/up/cancel for this
    // pointer id are delivered to the canvas regardless of cursor
    // travel. Closes the off-canvas release leak.
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* setPointerCapture may throw on some legacy paths; harmless. */
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    // Reconcile modifier state on every pointer event -- recovers from
    // focus-regain with the modifier still held without waiting for a
    // keypress.
    interaction.hover.setHeldModifier(keyModifierFromEvent(e));
    const xy = canvasXyFromEvent(e);
    const repaint = interaction.scenePointer.onPointerMove({
      pointerId: e.pointerId,
      xy,
    });
    if (repaint) {
      const g = interaction.scenePointer.getGesture();
      if (g.kind === "scene-rect-select") {
        drawRectSelectOverlay({ startXy: g.startXy, endXy: g.endXy });
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    const outcome = interaction.scenePointer.onPointerUp({
      pointerId: e.pointerId,
    });
    drawRectSelectOverlay(null);
    if (outcome.kind === "scene-click") {
      sendClickMessage(
        viewer,
        outcome.xy,
        outcome.modifier,
        sendClickThrottled,
      );
    } else if (outcome.kind === "scene-rect-select") {
      sendRectSelectMessage(
        viewer,
        { dragStart: outcome.startXy, dragEnd: outcome.endXy },
        outcome.modifier,
        sendClickThrottled,
      );
    }
    // Reconcile `cameraControl.enabled` with the held leases once the gesture
    // ends. drei's PivotControls (orbit-origin gizmo, transform controls)
    // disables the camera directly during a drag and only re-enables it in its
    // own pointerup -- which is skipped on a pointercancel or a release where
    // pointer capture was lost. Without this the camera would be left disabled
    // (no lease held) and orbit/pan would silently stop working.
    interaction.cameraLocks.apply();
  };

  const fixedDpr = viewer.useDevSettings((state) => state.fixedDpr);
  const sceneContents = React.useMemo(
    () => (
      <>
        <BackgroundImage />
        <SceneContextSetter />
        {memoizedCameraControls}
        <SplatRenderContext>
          <AdaptiveDpr />
          {children}
          <BatchedLabelManager>
            <DragLayer>
              <SceneNodeThreeObject name="" />
            </DragLayer>
          </BatchedLabelManager>
        </SplatRenderContext>
        <DefaultLights />
        <SceneFog />
      </>
    ),
    [children, memoizedCameraControls],
  );
  return (
    <div
      ref={inViewRef}
      style={{ position: "relative", zIndex: 0, width: "100%", height: "100%" }}
    >
      <Canvas
        gl={{ preserveDrawingBuffer: true, reversedDepthBuffer: true }}
        // `touchAction: none` opts the canvas out of native touch actions.
        // Without it the browser can reinterpret a curved/multi-touch drag
        // (e.g. dragging the orbit gizmo's rotation ring, especially on
        // trackpads) as a scroll/zoom gesture and fire `pointercancel`
        // mid-drag. drei's PivotControls has no cancel handler, so the gizmo
        // would be left stuck following the cursor. camera-controls handles
        // all viewport gestures itself, so there is nothing to lose.
        style={{ width: "100%", height: "100%", touchAction: "none" }}
        ref={(el) => {
          viewer.mutable.current.canvas = el;
          interaction.hover.refresh();
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={(e) => {
          interaction.cancelPointer(e.pointerId);
          drawRectSelectOverlay(null);
          // drei's PivotControls disables the camera on pointerdown and only
          // re-enables it in its own pointerup -- it has no pointercancel
          // handler. A canceled gizmo drag (common for the curved rotation-ring
          // gesture) would otherwise leave the camera disabled. Reconcile to
          // the lease state here so it recovers.
          interaction.cameraLocks.apply();
        }}
        onContextMenu={(e) => {
          // Suppress the browser context menu only for ctrl/cmd-modified
          // gestures that match a registered scene-pointer filter. macOS
          // fires contextmenu on ctrl+click, so without this a ctrl+click
          // scene-pointer callback would also pop the OS menu.
          //
          // We deliberately do NOT suppress plain right-clicks even when
          // a ``modifier=None`` filter is registered: scene-pointer click
          // callbacks are conventionally left-click, and stealing the
          // canvas's right-click menu wholesale (losing the inspector)
          // would surprise users who registered an unmodified callback.
          const modifier = keyModifierFromEvent(e);
          if (!hasCmdCtrl(modifier)) return;
          if (interaction.scenePointer.anyFilterMatches(modifier)) {
            e.preventDefault();
          }
        }}
        shadows="percentage"
        dpr={fixedDpr ?? undefined}
      >
        {!inView && <DisableRender />}
        {sceneContents}
      </Canvas>
    </div>
  );
}

// ======= Helper functions for pointer events. =======

/**
 * Send a click message based on the pointer position.
 */
function sendClickMessage(
  viewer: ViewerContextContents,
  pointerPos: [number, number],
  modifier: KeyModifier | null,
  sendClickThrottled: (message: any) => void,
) {
  const raycaster = new THREE.Raycaster();
  const mouseVector = ndcFromPointerXy(viewer, pointerPos);
  if (mouseVector === null) return;

  raycaster.setFromCamera(mouseVector, viewer.mutable.current.camera!);
  const ray = rayToViserCoords(viewer, raycaster.ray);
  const mouseVectorOpenCV = opencvXyFromPointerXy(viewer, pointerPos);

  sendClickThrottled({
    type: "ScenePointerMessage",
    event_type: "click",
    ray_origin: [ray.origin.x, ray.origin.y, ray.origin.z],
    ray_direction: [ray.direction.x, ray.direction.y, ray.direction.z],
    screen_pos: [[mouseVectorOpenCV.x, mouseVectorOpenCV.y]],
    modifier,
  });
}

/**
 * Send a rectangle selection message based on drag start/end positions.
 */
function sendRectSelectMessage(
  viewer: ViewerContextContents,
  pointerInfo: { dragStart: [number, number]; dragEnd: [number, number] },
  modifier: KeyModifier | null,
  sendClickThrottled: (message: any) => void,
) {
  const firstMouseVector = opencvXyFromPointerXy(viewer, pointerInfo.dragStart);
  const lastMouseVector = opencvXyFromPointerXy(viewer, pointerInfo.dragEnd);

  const x_min = Math.min(firstMouseVector.x, lastMouseVector.x);
  const x_max = Math.max(firstMouseVector.x, lastMouseVector.x);
  const y_min = Math.min(firstMouseVector.y, lastMouseVector.y);
  const y_max = Math.max(firstMouseVector.y, lastMouseVector.y);

  sendClickThrottled({
    type: "ScenePointerMessage",
    event_type: "rect-select",
    ray_origin: null,
    ray_direction: null,
    screen_pos: [
      [x_min, y_min],
      [x_max, y_max],
    ],
    modifier,
  });
}

/**
 * DefaultLights component - handles environment map and lights.
 */
function DefaultLights() {
  const viewer = React.useContext(ViewerContext)!;
  const enableDefaultLights = viewer.useEnvironment(
    (state) => state.enableDefaultLights,
  );
  const enableDefaultLightsShadows = viewer.useEnvironment(
    (state) => state.enableDefaultLightsShadows,
  );
  const environmentMap = viewer.useEnvironment((state) => state.environmentMap);

  // Get world rotation directly from scene tree state.
  const worldRotation = viewer.useSceneTree(
    "",
    (node) => node?.wxyz ?? [1, 0, 0, 0],
    shallowArrayEqual,
  );

  // Calculate environment map.
  // Uses HDR JPEG (gainmap) format for smaller file sizes (~10x reduction).
  const envMapNode = useMemo(() => {
    if (environmentMap.hdri === null) return null;

    // Calculate quaternions for world transformation.
    const Rquat_threeworld_world = new THREE.Quaternion(
      worldRotation[1],
      worldRotation[2],
      worldRotation[3],
      worldRotation[0],
    );
    const Rquat_world_threeworld = Rquat_threeworld_world.clone().invert();

    // Calculate background rotation.
    const backgroundRotation = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion(
        environmentMap.background_wxyz[1],
        environmentMap.background_wxyz[2],
        environmentMap.background_wxyz[3],
        environmentMap.background_wxyz[0],
      )
        .premultiply(Rquat_threeworld_world)
        .multiply(Rquat_world_threeworld),
    );

    // Calculate environment rotation.
    const environmentRotation = new THREE.Euler().setFromQuaternion(
      new THREE.Quaternion(
        environmentMap.environment_wxyz[1],
        environmentMap.environment_wxyz[2],
        environmentMap.environment_wxyz[3],
        environmentMap.environment_wxyz[0],
      )
        .premultiply(Rquat_threeworld_world)
        .multiply(Rquat_world_threeworld),
    );

    return (
      <HDRJPGEnvironment
        files={hdriPresets[environmentMap.hdri]}
        background={environmentMap.background}
        backgroundBlurriness={environmentMap.background_blurriness}
        backgroundIntensity={environmentMap.background_intensity}
        backgroundRotation={backgroundRotation}
        environmentIntensity={environmentMap.environment_intensity}
        environmentRotation={environmentRotation}
      />
    );
  }, [environmentMap, worldRotation]);

  // Return environment map only if lights are disabled.
  if (!enableDefaultLights) return envMapNode;

  // Return lights and environment map.
  return (
    <>
      <CsmDirectionalLight
        lightIntensity={3.0}
        position={[-0.2, 1.0, -0.2]}
        cascades={3}
        castShadow={enableDefaultLightsShadows}
      />
      <CsmDirectionalLight
        lightIntensity={0.4}
        position={[0, -1, 0]}
        castShadow={false}
      />
      {envMapNode}
    </>
  );
}

/**
 * SceneFog component - applies THREE.Fog to the scene based on fog state.
 */
function SceneFog() {
  const viewer = React.useContext(ViewerContext)!;
  const fog = viewer.useEnvironment((state) => state.fog);
  const scene = useThree((state) => state.scene);

  React.useEffect(() => {
    if (fog.enabled) {
      scene.fog = new THREE.Fog(
        new THREE.Color(
          fog.color[0] / 255,
          fog.color[1] / 255,
          fog.color[2] / 255,
        ),
        fog.near,
        fog.far,
      );
    } else {
      scene.fog = null;
    }
    return () => {
      scene.fog = null;
    };
  }, [fog, scene]);

  return null;
}

/**
 * Adaptive DPR component for performance optimization.
 */
function AdaptiveDpr() {
  const viewer = React.useContext(ViewerContext)!;
  const setDpr = useThree((state) => state.setDpr);
  const fixedDpr = viewer.useDevSettings((state) => state.fixedDpr);

  return fixedDpr !== null ? null : (
    <PerformanceMonitor
      factor={1.0}
      step={0.5}
      bounds={(refreshrate) => {
        const max = Math.min(refreshrate * 0.75, 85);
        const min = Math.max(max * 0.3, 38);
        return [min, max];
      }}
      onChange={({ factor, fps, refreshrate }) => {
        const dpr = window.devicePixelRatio * (0.75 + 0.25 * factor);
        console.log(
          `[Performance] Setting DPR to ${dpr}; FPS=${fps}/${refreshrate}`,
        );
        setDpr(dpr);
      }}
    />
  );
}

/**
 * 2D canvas overlay for drawing selection rectangles.
 */
function Viewer2DCanvas() {
  const viewer = React.useContext(ViewerContext)!;

  useEffect(() => {
    const canvas = viewer.mutable.current.canvas2d!;

    // Create a resize observer to update canvas dimensions.
    const resizeObserver = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      canvas.width = width;
      canvas.height = height;
    });

    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <canvas
      ref={(el) => (viewer.mutable.current.canvas2d = el)}
      style={{
        position: "absolute",
        zIndex: 1,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
      }}
    />
  );
}

/**
 * Background image component with depth support.
 */
function BackgroundImage() {
  // Shader for background image with depth.
  const shaders = useMemo(
    () => ({
      vert: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
    `,
      frag: `
    #include <packing>
    precision highp float;
    precision highp int;

    varying vec2 vUv;
    uniform sampler2D colorMap;
    uniform sampler2D depthMap;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform bool enabled;
    uniform bool hasDepth;

    float readDepth(sampler2D depthMap, vec2 coord) {
      vec4 rgbPacked = texture(depthMap, coord);
      // Important: BGR format, because buffer was encoded using OpenCV.
      float depth = rgbPacked.b * 0.00255 + rgbPacked.g * 0.6528 + rgbPacked.r * 167.1168;
      return depth;
    }

    void main() {
      if (!enabled) {
        discard;
      }
      vec4 color = texture(colorMap, vUv);
      gl_FragColor = vec4(color.rgb, 1.0);

      float bufDepth;
      if(hasDepth){
        float depth = readDepth(depthMap, vUv);
        bufDepth = viewZToPerspectiveDepth(-depth, cameraNear, cameraFar);
        #ifdef USE_REVERSED_DEPTH_BUFFER
          bufDepth = 1.0 - bufDepth;
        #endif
      } else {
        // Far plane: 1.0 for standard depth, 0.0 for reversed depth.
        #ifdef USE_REVERSED_DEPTH_BUFFER
          bufDepth = 0.0;
        #else
          bufDepth = 1.0;
        #endif
      }
      gl_FragDepth = bufDepth;
    }
    `,
    }),
    [],
  );

  // Create material.
  const backgroundMaterial = useMemo(
    () =>
      new THREE.ShaderMaterial({
        fragmentShader: shaders.frag,
        vertexShader: shaders.vert,
        uniforms: {
          enabled: { value: false },
          depthMap: { value: null },
          colorMap: { value: null },
          cameraNear: { value: null },
          cameraFar: { value: null },
          hasDepth: { value: false },
        },
      }),
    [shaders],
  );

  // Store material in viewer context.
  const { mutable } = React.useContext(ViewerContext)!;
  mutable.current.backgroundMaterial = backgroundMaterial;
  const backgroundMesh = React.useRef<THREE.Mesh>(null);
  // Reused every frame to avoid a per-frame Vector3 allocation in the loop.
  const lookdirRef = React.useRef(new THREE.Vector3());

  // Update position and rotation in render loop.
  useFrame(({ camera }) => {
    if (!(camera instanceof THREE.PerspectiveCamera)) {
      console.error(
        "Camera is not a perspective camera, cannot render background image.",
      );
      return;
    }

    const mesh = backgroundMesh.current!;

    // Position behind camera.
    const lookdir = camera.getWorldDirection(lookdirRef.current);
    mesh.position.copy(camera.position).addScaledVector(lookdir, 1.0);
    mesh.quaternion.copy(camera.quaternion);

    // Size based on camera parameters.
    const f = camera.getFocalLength();
    mesh.scale.set(camera.getFilmWidth() / f, camera.getFilmHeight() / f, 1.0);

    // Update shader uniforms.
    backgroundMaterial.uniforms.cameraNear.value = camera.near;
    backgroundMaterial.uniforms.cameraFar.value = camera.far;
  });

  return (
    <mesh ref={backgroundMesh} material={backgroundMaterial}>
      <planeGeometry attach="geometry" args={[1, 1]} />
    </mesh>
  );
}

/**
 * Helper component to sync scene and camera state.
 */
function SceneContextSetter() {
  const viewer = React.useContext(ViewerContext)!;
  const { mutable } = viewer;
  mutable.current.scene = useThree((state) => state.scene);
  mutable.current.camera = useThree(
    (state) => state.camera as THREE.PerspectiveCamera,
  );

  const gl = useThree((state) => state.gl);
  const setSize = useThree((state) => state.setSize);

  // Register a SYNCHRONOUS canvas-size sync (see ViewerMutable.syncCanvasSize).
  // R3F normally resizes the renderer from a ResizeObserver on the canvas
  // wrapper, which fires asynchronously AFTER layout -- so while the user drags
  // a docked region's width handle, the panel edge (CSS) moves immediately but
  // the GL backbuffer trails a frame behind, and the rendered scene visibly
  // lags the divider on a fast drag. The dock calls this right after it commits
  // (flushes) the new region width, so the renderer resizes to the canvas's new
  // CSS box on the SAME tick. R3F's own observer fires moments later and finds
  // the size already current, so the two never fight.
  useEffect(() => {
    mutable.current.syncCanvasSize = (width: number, height: number) => {
      if (width <= 0 || height <= 0) return;
      // setSize updates the drawing buffer + R3F's size store + camera aspect.
      setSize(width, height);
      // Paint THIS frame into the freshly-sized buffer (don't wait for R3F's
      // next rAF), so the scene doesn't trail the panel edge during the drag.
      const scene = mutable.current.scene;
      const camera = mutable.current.camera;
      if (scene !== null && camera !== null) gl.render(scene, camera);
    };
    return () => {
      mutable.current.syncCanvasSize = null;
    };
  }, [mutable, gl, setSize]);

  // Expose scene internals on window for E2E testing (Playwright).
  useEffect(() => {
    const w = window as any;
    w.__viserMutable = mutable.current;
    w.__viserPointer = viewer.interaction.testApi();
    // Expose a shim for E2E tests.
    w.__viserSceneTree = {
      getState: () => viewer.useSceneTree.getAll(),
      subscribe: (listener: () => void) => {
        // Subscribe to all key changes -- for benchmarking purposes.
        // This uses a polling approach via the store's internal mechanism.
        const unsubs: (() => void)[] = [];
        const state = viewer.useSceneTree.getAll();
        for (const key of Object.keys(state)) {
          unsubs.push(viewer.useSceneTree.subscribe(key, listener));
        }
        return () => unsubs.forEach((u) => u());
      },
    };
    w.__viserTestpoints = {
      rendererInfo: gl.info,
      // Exposed for E2E regression tests of dev-settings-driven behavior
      // (e.g. ``logCamera`` stale-closure fix, see
      // ``tests/e2e/test_dev_settings_log_camera.py``).
      devSettings: viewer.useDevSettings,
    };

    return () => {
      delete w.__viserMutable;
      delete w.__viserPointer;
      delete w.__viserSceneTree;
      delete w.__viserTestpoints;
    };
  }, [mutable, viewer.useSceneTree, viewer.useDevSettings, gl]);

  return null;
}

/**
 * Viser logo with about modal.
 */
function ViserLogo() {
  const [aboutModalOpened, { open: openAbout, close: closeAbout }] =
    useDisclosure(false);

  return (
    <>
      <Tooltip label={`Viser ${VISER_VERSION}`}>
        <Box
          style={{
            position: "absolute",
            bottom: "1em",
            left: "1em",
            cursor: "pointer",
          }}
          component="a"
          onClick={openAbout}
          title="About Viser"
        >
          <Image src={logoSvg} style={{ width: "2.5em", height: "auto" }} />
        </Box>
      </Tooltip>
      <Modal
        opened={aboutModalOpened}
        onClose={closeAbout}
        withCloseButton={false}
        size="xl"
        style={{ textAlign: "center" }}
        trapFocus={false}
      >
        <Box pt="lg" pb="xs">
          Viser is a 3D visualization toolkit developed at UC Berkeley.
        </Box>
        <Box pb="lg">
          <Anchor
            href="https://viser.studio/main"
            target="_blank"
            style={{ fontWeight: "600" }}
          >
            Documentation
          </Anchor>
          &nbsp;&nbsp;&bull;&nbsp;&nbsp;
          <Anchor
            href="https://github.com/viser-project/viser"
            target="_blank"
            style={{ fontWeight: "600" }}
          >
            GitHub
          </Anchor>
        </Box>
        <Divider />
        <Box
          style={{
            textAlign: "left",
            lineHeight: "1",
            fontSize: "0.8rem",
            opacity: "0.75",
          }}
          px="md"
          pt="sm"
        >
          Thanks to our contributors!{" "}
          {GITHUB_CONTRIBUTORS.map(
            (contributor: Contributor, index: number) => (
              <span key={contributor.login}>
                <Anchor
                  href={contributor.html_url}
                  target="_blank"
                  style={{
                    textDecoration: "none",
                    fontSize: "0.75rem",
                    lineHeight: "1.2",
                  }}
                >
                  {contributor.login}
                </Anchor>
                {index < GITHUB_CONTRIBUTORS.length - 1 && ", "}
              </span>
            ),
          )}
        </Box>
      </Modal>
    </>
  );
}
