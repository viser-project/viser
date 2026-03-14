import * as React from "react";
import { Box, Flex, Text, NumberInput, Tooltip } from "@mantine/core";
import { GuiComponentContext } from "../ControlPanel/GuiComponentContext";

export function ViserInputComponent({
  uuid,
  label,
  hint,
  children,
}: {
  uuid: string;
  children: React.ReactNode;
  label?: string;
  hint?: string | null;
}) {
  const { folderDepth } = React.useContext(GuiComponentContext)!;
  if (hint !== undefined && hint !== null) {
    children = // We need to add <Box /> for inputs that we can't assign refs to.
      (
        <Tooltip
          zIndex={100}
          label={hint}
          multiline
          style={{ width: "15rem" }}
          withArrow
          openDelay={500}
          withinPortal
        >
          <Box>{children}</Box>
        </Tooltip>
      );
  }

  if (label !== undefined)
    children = (
      <LabeledInput
        uuid={uuid}
        label={label}
        input={children}
        folderDepth={folderDepth}
      />
    );

  return (
    <Box pb="0.5em" px="xs">
      {children}
    </Box>
  );
}

/** GUI input with a label horizontally placed to the left of it. */
function LabeledInput(props: {
  uuid: string;
  label: string;
  input: React.ReactNode;
  folderDepth: number;
}) {
  return (
    <Flex align="center">
      <Box
        // The per-layer offset here is just eyeballed.
        pr="xs"
        style={{
          width: `${7.25 - props.folderDepth * 0.6375}em`,
          flexShrink: 0,
          position: "relative",
        }}
      >
        <Text
          c="dimmed"
          style={{
            fontSize: "0.875em",
            fontWeight: "450",
            lineHeight: "1.375em",
            letterSpacing: "-0.75px",
            width: "100%",
            boxSizing: "content-box",
            overflowWrap: "anywhere",
          }}
          unselectable="off"
        >
          <label htmlFor={props.uuid}>
            {props.label.split(/(?<=[_\-/.])/).map((part, i) => (
              <React.Fragment key={i}>
                {i > 0 && <wbr />}
                {part}
              </React.Fragment>
            ))}
          </label>
        </Text>
      </Box>
      <Box style={{ flexGrow: 1 }}>{props.input}</Box>
    </Flex>
  );
}

export function VectorInput(
  props:
    | {
        uuid: string;
        n: 2;
        value: [number, number];
        min: [number, number] | null;
        max: [number, number] | null;
        step: number;
        precision: number;
        onChange: (value: number[]) => void;
        disabled: boolean;
      }
    | {
        uuid: string;
        n: 3;
        value: [number, number, number];
        min: [number, number, number] | null;
        max: [number, number, number] | null;
        step: number;
        precision: number;
        onChange: (value: number[]) => void;
        disabled: boolean;
      },
) {
  return (
    <Flex justify="space-between" columnGap="0.5em">
      {[...Array(props.n).keys()].map((i) => (
        <NumberInput
          id={i === 0 ? props.uuid : undefined}
          key={i}
          value={props.value[i]}
          onChange={(v) => {
            const updated = [...props.value];
            updated[i] = v === "" ? 0.0 : Number(v);
            props.onChange(updated);
          }}
          size="xs"
          styles={{
            root: { flexGrow: 1, width: 0 },
            input: {
              paddingLeft: "0.5em",
              paddingRight: "1.75em",
              textAlign: "right",
              height: "1.875em",
              minHeight: "1.875em",
            },
            controls: {
              height: "1.25em",
              width: "0.825em",
            },
          }}
          rightSectionWidth="1em"
          decimalScale={props.precision}
          step={props.step}
          min={props.min === null ? undefined : props.min[i]}
          max={props.max === null ? undefined : props.max[i]}
          stepHoldDelay={500}
          stepHoldInterval={(t) => Math.max(1000 / t ** 2, 25)}
          disabled={props.disabled}
        />
      ))}
    </Flex>
  );
}
