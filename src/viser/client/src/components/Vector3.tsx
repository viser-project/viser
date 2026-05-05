import * as React from "react";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { GuiVector3Message } from "../WebsocketMessages";
import { VectorInput, ViserInputComponent } from "./common";

export default function Vector3Component({
  uuid,
  value,
  props: { hint, label, visible, disabled, min, max, step, precision },
}: GuiVector3Message) {
  const { setValue } = React.useContext(GuiComponentContext)!;
  if (!visible) return null;
  return (
    <ViserInputComponent {...{ uuid, hint, label }}>
      <VectorInput
        uuid={uuid}
        n={3}
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
