import { Box, Divider } from "@mantine/core";
import { GuiDividerMessage } from "../WebsocketMessages";

function DividerComponent({ props }: GuiDividerMessage) {
  if (!props.visible) return null;
  // Match `ViserInputComponent`'s wrapper (pb="0.5em" px="xs"). Other GUI
  // elements add 0.5em of padding below themselves but nothing above, so
  // mirroring that here keeps the divider line visually centered between its
  // neighbors. Color matches <Paper withBorder> used by folders.
  return (
    <Box pb="0.5em" px="xs">
      <Divider color="var(--mantine-color-default-border)" />
    </Box>
  );
}

export default DividerComponent;
