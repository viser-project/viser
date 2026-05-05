import { GuiButtonMessage } from "../WebsocketMessages";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";
import { Box } from "@mantine/core";

import { Button } from "@mantine/core";
import React, { useRef, useCallback, useEffect } from "react";
import { htmlIconWrapper } from "./ComponentStyles.css";
import { toMantineColor } from "./colorUtils";

export default function ButtonComponent({
  uuid,
  props: {
    visible,
    disabled,
    label,
    color,
    _icon_html: icon_html,
    _hold_callback_freqs: holdCallbackFreqs,
  },
}: GuiButtonMessage) {
  const { messageSender } = React.useContext(GuiComponentContext)!;
  const holdIntervalsRef = useRef<ReturnType<typeof setInterval>[]>([]);

  const stopHoldTimers = useCallback(() => {
    holdIntervalsRef.current.forEach(clearInterval);
    holdIntervalsRef.current = [];
  }, []);

  // Clean up on unmount or when disabled.
  useEffect(() => stopHoldTimers, [stopHoldTimers]);
  useEffect(() => {
    if (disabled) stopHoldTimers();
  }, [disabled, stopHoldTimers]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only handle left click.
      if (e.button !== 0) return;
      if (holdCallbackFreqs.length === 0) return;
      // Prevent duplicate timers from multiple pointers.
      if (holdIntervalsRef.current.length > 0) return;

      // Capture pointer to receive pointerup even if released outside element.
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      for (const freq of holdCallbackFreqs) {
        messageSender({ type: "GuiButtonHoldMessage", uuid, frequency: freq });
        holdIntervalsRef.current.push(
          setInterval(
            () =>
              messageSender({
                type: "GuiButtonHoldMessage",
                uuid,
                frequency: freq,
              }),
            1000 / freq,
          ),
        );
      }
    },
    [holdCallbackFreqs, messageSender, uuid],
  );

  if (!(visible ?? true)) return null;

  return (
    <Box mx="xs" pb="0.5em">
      <Button
        id={uuid}
        fullWidth
        color={toMantineColor(color)}
        onClick={() =>
          messageSender({
            type: "GuiUpdateMessage",
            uuid: uuid,
            updates: { value: true },
          })
        }
        onPointerDown={handlePointerDown}
        onPointerUp={stopHoldTimers}
        onPointerCancel={stopHoldTimers}
        onLostPointerCapture={stopHoldTimers}
        style={{ height: "2em" }}
        disabled={disabled ?? false}
        size="sm"
        leftSection={
          icon_html === null ? undefined : (
            <div
              className={htmlIconWrapper}
              dangerouslySetInnerHTML={{ __html: icon_html }}
            />
          )
        }
      >
        {label}
      </Button>
    </Box>
  );
}
