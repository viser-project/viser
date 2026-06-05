import * as React from "react";
import { ColorInput } from "@mantine/core";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { ViserInputComponent } from "./common";
import { IconColorPicker } from "@tabler/icons-react";

/** Shared implementation for the RGB and RGBA color inputs.
 *
 * The two differ only in their tuple width and the Mantine `format`, so they
 * delegate here with format-specific string/parse/equality helpers. `value` is
 * the parsed tuple; the local state holds the in-progress text so mid-edit
 * typing isn't reset by prop syncs. */
export function ColorInputComponent<V extends NonNullable<unknown>>({
  uuid,
  value,
  label,
  hint,
  disabled,
  visible,
  format,
  toString,
  parse,
  equal,
}: {
  uuid: string;
  value: V;
  label: string;
  hint: string | null;
  disabled: boolean;
  visible: boolean;
  format: "rgb" | "rgba";
  toString: (value: V) => string;
  parse: (value: string) => V | null;
  equal: (a: V, b: V) => boolean;
}) {
  const { setValue } = React.useContext(GuiComponentContext)!;

  // Local state for the input value.
  const [localValue, setLocalValue] = React.useState(toString(value));

  // Sync local text from the prop only when `value` changes, not on every
  // `localValue` keystroke -- otherwise mid-edit text resets.
  React.useEffect(() => {
    // Only update if the parsed local value differs from the new prop value.
    const parsedLocal = parse(localValue);
    if (!parsedLocal || !equal(parsedLocal, value)) {
      setLocalValue(toString(value));
    }
  }, [value]);

  if (!visible) return null;

  return (
    <ViserInputComponent {...{ uuid, hint, label }}>
      <ColorInput
        disabled={disabled}
        size="xs"
        value={localValue}
        format={format}
        eyeDropperIcon={<IconColorPicker size={18} stroke={1.5} />}
        popoverProps={{ zIndex: 1000 }}
        styles={{
          input: { height: "1.625rem", minHeight: "1.625rem" },
        }}
        onChange={(v) => {
          // Always update local state for responsive typing.
          setLocalValue(v);

          // Only process the structured format during onChange (not hex).
          if (v.startsWith(format + "(")) {
            const parsed = parse(v);
            if (parsed && !equal(parsed, value)) {
              setValue(uuid, parsed);
            }
          }
        }}
        onKeyDown={(e) => {
          // Handle Enter key for hex color input.
          if (e.key === "Enter") {
            const parsed = parse(localValue);
            if (parsed) {
              setValue(uuid, parsed);
            }
            // Blur to close the color-picker popover on Enter (matches the
            // server-address input in ServerControls.tsx).
            e.currentTarget.blur();
          }
        }}
        onBlur={() => {
          // Parse any format when input loses focus.
          const parsed = parse(localValue);
          if (parsed && !equal(parsed, value)) {
            setValue(uuid, parsed);
          }
        }}
      />
    </ViserInputComponent>
  );
}
