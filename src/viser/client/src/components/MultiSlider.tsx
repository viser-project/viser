import React from "react";
import { GuiMultiSliderMessage } from "../WebsocketMessages";
import { Box } from "@mantine/core";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { ViserInputComponent } from "./common";
import { MultiSlider } from "./MultiSliderComponent";
import { sliderDefaultMarks } from "./ComponentStyles.css";

export default function MultiSliderComponent({
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
    fixed_endpoints,
    min_range,
  },
}: GuiMultiSliderMessage) {
  const { setValue } = React.useContext(GuiComponentContext)!;
  if (!visible) return null;
  const updateValue = (value: number[]) => setValue(uuid, value);
  const input = (
    <Box px="0.1em">
      <MultiSlider
        id={uuid}
        className={marks === null ? sliderDefaultMarks : undefined}
        min={min}
        max={max}
        step={step ?? undefined}
        fixedEndpoints={fixed_endpoints}
        precision={precision}
        minRange={min_range ?? undefined}
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
        value={value}
        onChange={updateValue}
        disabled={disabled}
      />
    </Box>
  );

  return (
    <ViserInputComponent {...{ uuid, hint, label }}>
      {input}
    </ViserInputComponent>
  );
}
