import * as React from "react";
import { DatePickerInput } from "@mantine/dates";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { ViserInputComponent } from "./common";
import { GuiDateMessage } from "../WebsocketMessages";
import { IconCalendar } from "@tabler/icons-react";

export default function DateComponent({
  uuid,
  value,
  props: { label, hint, disabled, visible },
}: GuiDateMessage) {
  const { setValue } = React.useContext(GuiComponentContext)!;

  // Convert ISO string to Date object.
  const dateValue = React.useMemo(() => new Date(value), [value]);

  // Local state for the input value.
  const [localValue, setLocalValue] = React.useState<Date | null>(dateValue);

  // Update local value when prop value changes.
  React.useEffect(() => {
    const newDate = new Date(value);
    // Only update if the timestamp differs significantly (more than 1 day).
    if (
      !localValue ||
      Math.abs(localValue.getTime() - newDate.getTime()) > 86400000
    ) {
      setLocalValue(newDate);
    }
  }, [value, localValue]);

  if (!visible) return null;

  return (
    <ViserInputComponent {...{ uuid, hint, label }}>
      <DatePickerInput
        disabled={disabled}
        size="xs"
        value={localValue}
        leftSection={<IconCalendar size={16} stroke={1.5} />}
        popoverProps={{ zIndex: 1000 }}
        styles={{
          input: { height: "1.625rem", minHeight: "1.625rem" },
        }}
        onChange={(value) => {
          // Mantine DatePickerInput returns Date or null.
          if (value === null) {
            return;
          }

          // Parse the string to Date.
          const date = typeof value === "string" ? new Date(value) : value;

          // Always update local state for responsive UI.
          setLocalValue(date);

          // Send ISO date string to server (YYYY-MM-DD format).
          // We use toISOString() and extract just the date part.
          setValue(uuid, date.toISOString().split("T")[0]);
        }}
      />
    </ViserInputComponent>
  );
}
