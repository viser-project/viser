import * as React from "react";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { GuiVector2Message } from "../WebsocketMessages";
import { VectorInput, ViserInputComponent } from "./common";

export default function Vector2Component({
  uuid,
  value,
  props: { hint, label, visible, disabled, min, max, step, precision },
}: GuiVector2Message) {
  const { setValue } = React.useContext(GuiComponentContext)!;
  if (!visible) return null;
  return (
    <ViserInputComponent {...{ uuid, hint, label }}>
      <VectorInput
        uuid={uuid}
        n={2}
        value={value}
        onChange={(value: any) => setValue(uuid, value)}
        min={min}
        max={max}
        step={step}
        precision={precision}
        disabled={disabled}
      />
    </ViserInputComponent>
  );
}
