import * as React from "react";
import { ColorInput } from "@mantine/core";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { ViserInputComponent } from "./common";
import { GuiRgbaMessage } from "../WebsocketMessages";
import { IconColorPicker } from "@tabler/icons-react";
import { rgbaToString, parseToRgba, rgbaEqual } from "./colorUtils";

export default function RgbaComponent({
  uuid,
  value,
  props: { label, hint, disabled, visible },
}: GuiRgbaMessage) {
  const { setValue } = React.useContext(GuiComponentContext)!;

  // Local state for the input value. `localValue` will be a string; `value`
  // will be an RGBA array with all values in range [0, 255].
  const [localValue, setLocalValue] = React.useState(rgbaToString(value));

  // Update local value when prop value changes.
  React.useEffect(() => {
    // Only update if the parsed local value differs from the new prop value.
    const parsedLocal = parseToRgba(localValue);
    if (!parsedLocal || !rgbaEqual(parsedLocal, value)) {
      setLocalValue(rgbaToString(value));
    }
  }, [value, localValue]);

  if (!visible) return null;

  return (
    <ViserInputComponent {...{ uuid, hint, label }}>
      <ColorInput
        disabled={disabled}
        size="xs"
        value={localValue}
        format="rgba"
        eyeDropperIcon={<IconColorPicker size={18} stroke={1.5} />}
        popoverProps={{ zIndex: 1000 }}
        styles={{
          input: { height: "1.625rem", minHeight: "1.625rem" },
        }}
        onChange={(v) => {
          // Always update local state for responsive typing.
          setLocalValue(v);

          // Only process RGBA format during onChange (not hex).
          if (v.startsWith("rgba(")) {
            const parsed = parseToRgba(v);
            if (parsed && !rgbaEqual(parsed, value)) {
              setValue(uuid, parsed);
            }
          }
        }}
        onKeyDown={(e) => {
          // Handle Enter key for hex color input.
          if (e.key === "Enter") {
            const parsed = parseToRgba(localValue);
            if (parsed) {
              setValue(uuid, parsed);
            }
          }
        }}
        onBlur={() => {
          // Parse any format when input loses focus.
          const parsed = parseToRgba(localValue);
          if (parsed && !rgbaEqual(parsed, value)) {
            setValue(uuid, parsed);
          }
        }}
      />
    </ViserInputComponent>
  );
}
