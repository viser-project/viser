import { Box, Progress } from "@mantine/core";
import { GuiProgressBarMessage } from "../WebsocketMessages";
import { toMantineColor } from "./colorUtils";

export default function ProgressBarComponent({
  value,
  props: { visible, color, animated },
}: GuiProgressBarMessage) {
  if (!visible) return null;
  return (
    <Box pb="xs" px="xs">
      <Progress
        radius="xs"
        color={toMantineColor(color)}
        value={value}
        animated={animated}
        transitionDuration={0}
      />
    </Box>
  );
}
