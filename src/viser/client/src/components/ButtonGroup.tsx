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
      <Flex justify="space-between" columnGap="xs">
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
            style={{ flexGrow: 1, wuuidth: 0 }}
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
