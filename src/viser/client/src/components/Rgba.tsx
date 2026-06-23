import { ColorInputComponent } from "./ColorInputComponent";
import { GuiRgbaMessage } from "../WebsocketMessages";
import { rgbaToString, parseToRgba, rgbaEqual } from "./colorUtils";

export default function RgbaComponent({
  uuid,
  value,
  props: { label, hint, disabled, visible },
}: GuiRgbaMessage) {
  return (
    <ColorInputComponent
      {...{ uuid, value, label, hint, disabled, visible }}
      format="rgba"
      toString={rgbaToString}
      parse={parseToRgba}
      equal={rgbaEqual}
    />
  );
}
