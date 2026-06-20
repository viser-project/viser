import * as React from "react";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { GuiNumberMessage } from "../WebsocketMessages";
import { ViserInputComponent } from "./common";
import { finiteNumberOrNull } from "./numberInputUtils";
import { NumberInput } from "@mantine/core";

export default function NumberInputComponent({
  uuid,
  value,
  props: { visible, label, hint, disabled, precision, min, max, step },
}: GuiNumberMessage) {
  const { setValue } = React.useContext(GuiComponentContext)!;
  if (!visible) return null;
  return (
    <ViserInputComponent {...{ uuid, hint, label }}>
      <NumberInput
        id={uuid}
        value={value}
        // This was renamed in Mantine v7.
        decimalScale={precision}
        min={min ?? undefined}
        max={max ?? undefined}
        step={step}
        size="xs"
        onChange={(newValue) => {
          // Ignore empty / partial input (e.g. "-", "1e"); committing those
          // would send NaN or a raw string to the server.
          const parsed = finiteNumberOrNull(newValue);
          if (parsed !== null) setValue(uuid, parsed);
        }}
        styles={{
          input: {
            minHeight: "1.625rem",
            height: "1.625rem",
          },
          controls: {
            height: "1.625em",
            width: "0.825em",
          },
        }}
        disabled={disabled}
        stepHoldDelay={500}
        stepHoldInterval={(t) => Math.max(1000 / t ** 2, 25)}
      />
    </ViserInputComponent>
  );
}
