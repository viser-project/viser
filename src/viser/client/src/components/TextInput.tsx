import * as React from "react";
import { TextInput, Textarea } from "@mantine/core";
import { ViserInputComponent } from "./common";
import { GuiTextMessage } from "../WebsocketMessages";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";

export default function TextInputComponent({
  uuid,
  value,
  props: { hint, label, disabled, visible, multiline, update_on },
}: GuiTextMessage) {
  const { setValue } = React.useContext(GuiComponentContext)!;
  const [localValue, setLocalValue] = React.useState(value);

  // Sync local value when server pushes a new value.
  React.useEffect(() => {
    setLocalValue(value);
  }, [value]);

  const submitMode = update_on === "submit";

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    if (!submitMode) {
      setValue(uuid, newValue);
    }
  };

  const handleSubmit = () => {
    if (submitMode) {
      setValue(uuid, localValue);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (submitMode && e.key === "Enter" && !multiline) {
      setValue(uuid, localValue);
    }
  };

  if (!visible) return null;
  return (
    <ViserInputComponent {...{ uuid, hint, label }}>
      {multiline ? (
        <Textarea
          value={localValue}
          size="xs"
          onChange={handleChange}
          onBlur={handleSubmit}
          onKeyDown={handleKeyDown}
          styles={{
            input: {
              padding: "0 0.5em",
            },
          }}
          disabled={disabled}
          minRows={2}
          maxRows={6}
          autosize
          resize="vertical"
        />
      ) : (
        <TextInput
          value={localValue}
          size="xs"
          onChange={handleChange}
          onBlur={handleSubmit}
          onKeyDown={handleKeyDown}
          styles={{
            input: {
              minHeight: "1.625rem",
              height: "1.625rem",
              padding: "0 0.5em",
            },
          }}
          disabled={disabled}
        />
      )}
    </ViserInputComponent>
  );
}
