import * as React from "react";
import { Button, Flex } from "@mantine/core";
import { ViserInputComponent } from "./common";
import { GuiButtonGroupMessage } from "../WebsocketMessages";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";

export default function ButtonGroupComponent({
  uuid,
  props: { hint, label, visible, disabled, options },
}: GuiButtonGroupMessage) {
  const { messageSender } = React.useContext(GuiComponentContext)!;
  if (!visible) return null;
  return (
    <ViserInputComponent {...{ uuid, hint, label }}>
      {/* Wrapping flex: buttons share each row's width equally, but never
      shrink below their label (minWidth fit-content) -- on a narrow panel the
      overflow wraps onto more rows instead of spilling out of the panel. */}
      <Flex wrap="wrap" gap="0.375em">
        {options.map((option, index) => (
          <Button
            key={index}
            onClick={() =>
              messageSender({
                type: "GuiUpdateMessage",
                uuid: uuid,
                updates: { value: option },
              })
            }
            style={{
              flexGrow: 1,
              flexBasis: 0,
              minWidth: "fit-content",
            }}
            disabled={disabled}
            size="compact-xs"
            variant="outline"
          >
            {option}
          </Button>
        ))}
      </Flex>
    </ViserInputComponent>
  );
}
