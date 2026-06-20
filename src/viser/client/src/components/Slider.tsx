import React from "react";
import { GuiSliderMessage } from "../WebsocketMessages";
import { Slider, Flex, NumberInput } from "@mantine/core";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { ViserInputComponent } from "./common";
import { finiteNumberOrNull } from "./numberInputUtils";
import { sliderDefaultMarks } from "./ComponentStyles.css";

export default function SliderComponent({
  uuid,
  value,
  props: {
    label,
    hint,
    visible,
    disabled,
    min,
    max,
    precision,
    step,
    _marks: marks,
  },
}: GuiSliderMessage) {
  const { setValue } = React.useContext(GuiComponentContext)!;
  const [dragging, setDragging] = React.useState(false);
  React.useEffect(() => {
    if (!dragging) return;
    const stop = () => setDragging(false);
    window.addEventListener("mouseup", stop);
    window.addEventListener("touchend", stop);
    window.addEventListener("touchcancel", stop);
    return () => {
      window.removeEventListener("mouseup", stop);
      window.removeEventListener("touchend", stop);
      window.removeEventListener("touchcancel", stop);
    };
  }, [dragging]);
  if (!visible) return null;
  const updateValue = (value: number) => setValue(uuid, value);
  const input = (
    <Flex justify="space-between">
      <Slider
        id={uuid}
        className={marks === null ? sliderDefaultMarks : undefined}
        size="xs"
        thumbSize={0}
        radius="xs"
        style={{ flexGrow: 1 }}
        onMouseDown={() => setDragging(true)}
        onTouchStart={() => setDragging(true)}
        onChangeEnd={() => setDragging(false)}
        styles={(theme) => ({
          thumb: {
            height: "0.75rem",
            width: "0.5rem",
            background: theme.colors[theme.primaryColor][6],
          },
          trackContainer: {
            zIndex: 3,
            position: "relative",
          },
          markLabel: {
            transform: "translate(-50%, 0.05rem)",
            fontSize: "0.6rem",
            textAlign: "center",
          },
          mark: {
            transform: "scale(2)",
          },
        })}
        pt="0.3em"
        pb="0.2em"
        showLabelOnHover={false}
        min={min}
        max={max}
        step={step ?? undefined}
        precision={precision}
        value={value}
        onChange={updateValue}
        marks={
          marks === null
            ? [
                {
                  value: min,
                  // The regex here removes trailing zeros and the decimal
                  // point if the number is an integer.
                  label: `${min.toFixed(6).replace(/\.?0+$/, "")}`,
                },
                {
                  value: max,
                  // The regex here removes trailing zeros and the decimal
                  // point if the number is an integer.
                  label: `${max.toFixed(6).replace(/\.?0+$/, "")}`,
                },
              ]
            : marks
        }
        disabled={disabled}
      />
      <NumberInput
        value={value}
        onChange={(newValue) => {
          // Ignore empty / partial input (e.g. "-", "1e"); committing those
          // would push NaN into the slider and send it to the server.
          const parsed = finiteNumberOrNull(newValue);
          if (parsed !== null) updateValue(parsed);
        }}
        size="xs"
        min={min}
        max={max}
        hideControls
        step={step ?? undefined}
        // Limit typed decimals to the slider's precision (0 for integer
        // sliders), so the companion box can't send a fractional/over-precise
        // value that the slider track itself would never produce.
        decimalScale={precision}
        style={{ width: "3rem" }}
        styles={{
          input: {
            padding: "0.375em",
            letterSpacing: "-0.5px",
            minHeight: "1.875em",
            height: "1.875em",
          },
        }}
        ml="xs"
      />
    </Flex>
  );

  return (
    <ViserInputComponent
      uuid={uuid}
      hint={hint}
      label={label}
      hintDisabled={dragging}
    >
      {input}
    </ViserInputComponent>
  );
}
