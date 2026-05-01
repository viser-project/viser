import * as React from "react";
import { TimeInput } from "@mantine/dates";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { ViserInputComponent } from "./common";
import { GuiTimeMessage } from "../WebsocketMessages";
import { IconClock } from "@tabler/icons-react";

export default function TimeComponent({
  uuid,
  value,
  props: { label, hint, disabled, visible },
}: GuiTimeMessage) {
  const { setValue } = React.useContext(GuiComponentContext)!;

  // Local state for the input value (store as string for TimeInput).
  const [localValue, setLocalValue] = React.useState<string>(value);

  // Update local value when prop value changes.
  React.useEffect(() => {
    // Only update if the value actually changed.
    if (value !== localValue) {
      setLocalValue(value);
    }
  }, [value]);

  if (!visible) return null;

  return (
    <ViserInputComponent {...{ uuid, hint, label }}>
      <TimeInput
        disabled={disabled}
        size="xs"
        value={localValue}
        leftSection={<IconClock size={16} stroke={1.5} />}
        styles={{
          input: { height: "1.625rem", minHeight: "1.625rem" },
        }}
        onChange={(event) => {
          const newValue = event.currentTarget.value;

          // Always update local state for responsive UI.
          setLocalValue(newValue);

          // Send ISO time string to server (HH:MM:SS format).
          // TimeInput gives us HH:MM, so we add :00 for seconds.
          if (newValue && newValue.includes(":")) {
            const timeParts = newValue.split(":");
            if (timeParts.length === 2) {
              setValue(uuid, `${newValue}:00`);
            } else {
              setValue(uuid, newValue);
            }
          }
        }}
      />
    </ViserInputComponent>
  );
}
