import { ViewerContext } from "../ViewerContext";
import { useThrottledMessageSender } from "../WebsocketUtils";
import { GuiComponentContext } from "./GuiComponentContext";
import {
  shallowObjectEqual,
  shallowObjectKeysEqual,
} from "../utils/shallowObjectKeysEqual";

import { Box } from "@mantine/core";
import React from "react";
import ButtonComponent from "../components/Button";
import SliderComponent from "../components/Slider";
import NumberInputComponent from "../components/NumberInput";
import TextInputComponent from "../components/TextInput";
import CheckboxComponent from "../components/Checkbox";
import Vector2Component from "../components/Vector2";
import Vector3Component from "../components/Vector3";
import DropdownComponent from "../components/Dropdown";
import RgbComponent from "../components/Rgb";
import RgbaComponent from "../components/Rgba";
import ButtonGroupComponent from "../components/ButtonGroup";
import MarkdownComponent from "../components/Markdown";
import PlotlyComponent from "../components/PlotlyComponent";
import UplotComponent from "../components/UplotComponent";
import TabGroupComponent from "../components/TabGroup";
import FolderComponent from "../components/Folder";
import FormComponent from "../components/Form";
import MultiSliderComponent from "../components/MultiSlider";
import UploadButtonComponent from "../components/UploadButton";
import ProgressBarComponent from "../components/ProgressBar";
import ImageComponent from "../components/Image";
import HtmlComponent from "../components/Html";
import DividerComponent from "../components/Divider";

/** Root of generated inputs. */
/** Dims and freezes its children while the websocket is not connected: the GUI
 * stays VISIBLE (last-known values) but every input is blocked, so a transient
 * disconnect isn't jarring and stale clicks can't fire. Applied inside
 * GuiComponentContextProvider, the single chokepoint all generated GUI funnels
 * through -- so it covers the control panel, every panel/tab, inline GUI, and the
 * mobile fallback in one place. The connection status in the panel header conveys
 * the "Connecting..." state. */
function DisconnectedGate({ children }: { children: React.ReactNode }) {
  const viewer = React.useContext(ViewerContext)!;
  const connected = viewer.useGui(
    (state) => state.websocketState === "connected",
  );
  return (
    <div
      // pointer-events:none blocks clicks/drags; opacity signals the frozen
      // state. (Keyboard focus into a dimmed input is harmless -- edits can't be
      // committed: the value change is dropped while the socket is closed.)
      style={{
        opacity: connected ? 1 : 0.5,
        pointerEvents: connected ? undefined : "none",
        transition: "opacity 150ms ease",
      }}
    >
      {children}
    </div>
  );
}

/** Provides the GuiComponentContext that generated GUI children (folders, tab
 * groups, inputs) read. Wrap any subtree that renders such children outside the
 * normal container tree -- e.g. standalone panels in the mobile fallback. Also
 * gates interaction on connection state (see DisconnectedGate). */
export function GuiComponentContextProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const viewer = React.useContext(ViewerContext)!;
  const updateGuiProps = viewer.guiActions.updateGuiProps;
  const messageSender = useThrottledMessageSender(50).send;

  function setValue(uuid: string, value: NonNullable<unknown>) {
    updateGuiProps(uuid, { value: value });
    messageSender({
      type: "GuiUpdateMessage",
      uuid: uuid,
      updates: { value: value },
    });
  }
  return (
    <GuiComponentContext.Provider
      value={{
        folderDepth: 0,
        GuiContainer: GuiContainer,
        messageSender: messageSender,
        setValue: setValue,
      }}
    >
      <DisconnectedGate>{children}</DisconnectedGate>
    </GuiComponentContext.Provider>
  );
}

export default function GeneratedGuiContainer({
  containerUuid,
}: {
  containerUuid: string;
}) {
  return (
    <GuiComponentContextProvider>
      <GuiContainer containerUuid={containerUuid} />
    </GuiComponentContextProvider>
  );
}

function GuiContainer({
  containerUuid,
  unwrapped = false,
}: {
  containerUuid: string;
  /** If true, don't wrap children in a padded Box. Used by label=null
   * folders and forms, which should be transparent for layout purposes. */
  unwrapped?: boolean;
}) {
  const viewer = React.useContext(ViewerContext)!;

  // Use a fallback empty object for containers that don't exist yet. Containers
  // are created on-demand by the addGui action when GUI elements are added.
  const guiIdSet = viewer.useGui(
    (state) => state.guiUuidSetFromContainerUuid[containerUuid] ?? {},
    shallowObjectKeysEqual,
  );

  // Render each GUI element in this container. (Standalone panels are a separate
  // top-level entity -- they never appear in any container set, so there is
  // nothing to filter here.)
  const guiIdArray = [...Object.keys(guiIdSet)];
  // Only THIS container's orders: guiOrderFromUuid is rebuilt on every GUI
  // add/remove anywhere, and subscribing to the whole map re-rendered every
  // mounted container per element during streaming loads.
  const guiOrderFromId = viewer!.useGui((state) => {
    const out: Record<string, number> = {};
    const set = state.guiUuidSetFromContainerUuid[containerUuid];
    if (set !== undefined)
      for (const uuid of Object.keys(set))
        out[uuid] = state.guiOrderFromUuid[uuid];
    return out;
  }, shallowObjectEqual);

  let guiUuidOrderPairArray = guiIdArray.map((uuid) => ({
    uuid: uuid,
    order: guiOrderFromId[uuid],
  }));
  guiUuidOrderPairArray = guiUuidOrderPairArray.sort(
    (a, b) => a.order - b.order,
  );
  const children = guiUuidOrderPairArray.map((pair, index) => (
    <GeneratedInput
      key={pair.uuid}
      guiUuid={pair.uuid}
      nextGuiUuid={guiUuidOrderPairArray[index + 1]?.uuid ?? null}
    />
  ));
  if (unwrapped) {
    return <>{children}</>;
  }
  return <Box pt="xs">{children}</Box>;
}

/** A single generated GUI element. */
function GeneratedInput(props: {
  guiUuid: string;
  nextGuiUuid: string | null;
}) {
  const viewer = React.useContext(ViewerContext)!;
  const conf = viewer.useGuiConfig(props.guiUuid);
  if (conf === undefined) {
    console.error("Tried to render non-existent component", props.guiUuid);
    return null;
  }
  switch (conf.type) {
    case "GuiFolderMessage":
      return <FolderComponent {...conf} nextGuiUuid={props.nextGuiUuid} />;
    case "GuiFormMessage":
      return <FormComponent {...conf} nextGuiUuid={props.nextGuiUuid} />;
    case "GuiTabGroupMessage":
      // TabGroupComponent decides how to render: a standalone panel inside the
      // dock surface is rendered there (StandalonePanelSync) so it renders null
      // here; outside the dock surface (mobile / static) it falls back to plain
      // tabs so its content stays visible.
      return <TabGroupComponent {...conf} />;
    case "GuiMarkdownMessage":
      return <MarkdownComponent {...conf} />;
    case "GuiHtmlMessage":
      return <HtmlComponent {...conf} />;
    case "GuiDividerMessage":
      return <DividerComponent {...conf} />;
    case "GuiPlotlyMessage":
      return <PlotlyComponent {...conf} />;
    case "GuiUplotMessage":
      return <UplotComponent {...conf} />;
    case "GuiImageMessage":
      return <ImageComponent {...conf} />;
    case "GuiButtonMessage":
      return <ButtonComponent {...conf} />;
    case "GuiUploadButtonMessage":
      return <UploadButtonComponent {...conf} />;
    case "GuiSliderMessage":
      return <SliderComponent {...conf} />;
    case "GuiMultiSliderMessage":
      return <MultiSliderComponent {...conf} />;
    case "GuiNumberMessage":
      return <NumberInputComponent {...conf} />;
    case "GuiTextMessage":
      return <TextInputComponent {...conf} />;
    case "GuiCheckboxMessage":
      return <CheckboxComponent {...conf} />;
    case "GuiVector2Message":
      return <Vector2Component {...conf} />;
    case "GuiVector3Message":
      return <Vector3Component {...conf} />;
    case "GuiDropdownMessage":
      return <DropdownComponent {...conf} />;
    case "GuiRgbMessage":
      return <RgbComponent {...conf} />;
    case "GuiRgbaMessage":
      return <RgbaComponent {...conf} />;
    case "GuiButtonGroupMessage":
      return <ButtonGroupComponent {...conf} />;
    case "GuiProgressBarMessage":
      return <ProgressBarComponent {...conf} />;
    default:
      assertNeverType(conf);
  }
}

function assertNeverType(x: never): never {
  throw new Error("Unexpected object: " + (x as any).type);
}
