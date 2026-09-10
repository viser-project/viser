import { Box, Progress } from "@mantine/core";
import { GuiProgressBarMessage } from "../WebsocketMessages";
import { toMantineColor } from "./colorUtils";

export default function ProgressBarComponent({
  value,
  props: { visible, color, animated },
}: GuiProgressBarMessage) {
  if (!visible) return null;
  return (
    // The fill is a width change per update; containment keeps that layout
    // local instead of dirtying the panel (streamed progress = many updates).
    <Box pb="xs" px="xs" style={{ contain: "layout paint" }}>
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
