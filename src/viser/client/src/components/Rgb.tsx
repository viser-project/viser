import * as React from "react";
import { ColorInput } from "@mantine/core";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { ViserInputComponent } from "./common";
import { GuiRgbMessage } from "../WebsocketMessages";
import { IconColorPicker } from "@tabler/icons-react";
import { rgbToString, parseToRgb, rgbEqual } from "./colorUtils";

export default function RgbComponent({
  uuid,
  value,
  props: { label, hint, disabled, visible },
}: GuiRgbMessage) {
  const { setValue } = React.useContext(GuiComponentContext)!;

  // Local state for the input value.
  const [localValue, setLocalValue] = React.useState(rgbToString(value));

  // Update local value when prop value changes.
  React.useEffect(() => {
    // Only update if the parsed local value differs from the new prop value.
    const parsedLocal = parseToRgb(localValue);
    if (!parsedLocal || !rgbEqual(parsedLocal, value)) {
      setLocalValue(rgbToString(value));
    }
  }, [value]);

  if (!visible) return null;

  return (
    <ViserInputComponent {...{ uuid, hint, label }}>
      <ColorInput
        disabled={disabled}
        size="xs"
        value={localValue}
        format="rgb"
        eyeDropperIcon={<IconColorPicker size={18} stroke={1.5} />}
        popoverProps={{ zIndex: 1000 }}
        styles={{
          input: { height: "1.625rem", minHeight: "1.625rem" },
        }}
        onChange={(v) => {
          // Always update local state for responsive typing.
          setLocalValue(v);

          // Only process RGB format during onChange (not hex).
          if (v.startsWith("rgb(")) {
            const parsed = parseToRgb(v);
            if (parsed && !rgbEqual(parsed, value)) {
              setValue(uuid, parsed);
            }
          }
        }}
        onKeyDown={(e) => {
          // Handle Enter key for hex color input.
          if (e.key === "Enter") {
            const parsed = parseToRgb(localValue);
            if (parsed) {
              setValue(uuid, parsed);
            }
          }
        }}
        onBlur={() => {
          // Parse any format when input loses focus.
          const parsed = parseToRgb(localValue);
          if (parsed && !rgbEqual(parsed, value)) {
            setValue(uuid, parsed);
          }
        }}
      />
    </ViserInputComponent>
  );
}
