import { ViewerContext } from "../ViewerContext";
import { useThrottledMessageSender } from "../WebsocketUtils";
import { GuiComponentContext } from "./GuiComponentContext";

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
import DatetimeComponent from "../components/Datetime";
import DateComponent from "../components/Date";
import TimeComponent from "../components/Time";
import ButtonGroupComponent from "../components/ButtonGroup";
import MarkdownComponent from "../components/Markdown";
import PlotlyComponent from "../components/PlotlyComponent";
import UplotComponent from "../components/UplotComponent";
import TabGroupComponent from "../components/TabGroup";
import FolderComponent from "../components/Folder";
import MultiSliderComponent from "../components/MultiSlider";
import UploadButtonComponent from "../components/UploadButton";
import ProgressBarComponent from "../components/ProgressBar";
import ImageComponent from "../components/Image";
import HtmlComponent from "../components/Html";

/** Root of generated inputs. */
export default function GeneratedGuiContainer({
  containerUuid,
}: {
  containerUuid: string;
}) {
  const viewer = React.useContext(ViewerContext)!;
  const updateGuiProps = viewer.useGui((state) => state.updateGuiProps);
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
      <GuiContainer containerUuid={containerUuid} />
    </GuiComponentContext.Provider>
  );
}

function GuiContainer({ containerUuid }: { containerUuid: string }) {
  const viewer = React.useContext(ViewerContext)!;

  // Ensure that the container exists in state. The goal of this is to prevent a race
  // condition where `guiIdSet` is undefined on first render, which prevents zustand
  // from tracking changes to it.
  if (
    viewer.useGui.getState().guiUuidSetFromContainerUuid[containerUuid] ===
    undefined
  ) {
    viewer.useGui.setState({
      ...viewer.useGui.getState(),
      guiUuidSetFromContainerUuid: {
        ...viewer.useGui.getState().guiUuidSetFromContainerUuid,
        [containerUuid]: {},
      },
    });
  }
  const guiIdSet = viewer.useGui(
    (state) => state.guiUuidSetFromContainerUuid[containerUuid],
  )!;

  // Render each GUI element in this container.
  const guiIdArray = [...Object.keys(guiIdSet)];
  const guiOrderFromId = viewer!.useGui((state) => state.guiOrderFromUuid);

  let guiUuidOrderPairArray = guiIdArray.map((uuid) => ({
    uuid: uuid,
    order: guiOrderFromId[uuid],
  }));
  guiUuidOrderPairArray = guiUuidOrderPairArray.sort(
    (a, b) => a.order - b.order,
  );
  const out = (
    <Box pt="xs">
      {guiUuidOrderPairArray.map((pair, index) => (
        <GeneratedInput
          key={pair.uuid}
          guiUuid={pair.uuid}
          nextGuiUuid={guiUuidOrderPairArray[index + 1]?.uuid ?? null}
        />
      ))}
    </Box>
  );
  return out;
}

/** A single generated GUI element. */
function GeneratedInput(props: {
  guiUuid: string;
  nextGuiUuid: string | null;
}) {
  const viewer = React.useContext(ViewerContext)!;
  const conf = viewer.useGui((state) => state.guiConfigFromUuid[props.guiUuid]);
  if (conf === undefined) {
    console.error("Tried to render non-existent component", props.guiUuid);
    return null;
  }
  switch (conf.type) {
    case "GuiFolderMessage":
      return <FolderComponent {...conf} nextGuiUuid={props.nextGuiUuid} />;
    case "GuiTabGroupMessage":
      return <TabGroupComponent {...conf} />;
    case "GuiMarkdownMessage":
      return <MarkdownComponent {...conf} />;
    case "GuiHtmlMessage":
      return <HtmlComponent {...conf} />;
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
    case "GuiDatetimeMessage":
      return <DatetimeComponent {...conf} />;
    case "GuiDateMessage":
      return <DateComponent {...conf} />;
    case "GuiTimeMessage":
      return <TimeComponent {...conf} />;
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
