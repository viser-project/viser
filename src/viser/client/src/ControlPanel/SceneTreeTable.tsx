import {
  IconCaretDown,
  IconCaretRight,
  IconEye,
  IconEyeOff,
  IconPencil,
  IconDeviceFloppy,
  IconX,
  IconEyeX,
} from "@tabler/icons-react";
import React from "react";
import {
  editIconWrapper,
  propsWrapper,
  tableHierarchyLine,
  tableRow,
  tableWrapper,
} from "./SceneTreeTable.css";
import { useDisclosure } from "@mantine/hooks";
import { useForm } from "@mantine/form";
import { ViewerContext } from "../ViewerContext";
import { SceneNode } from "../SceneTreeState";
import { shallowArrayEqual } from "../utils/shallowArrayEqual";
import {
  ScenePropDescriptor,
  SceneNodePropsSchema,
} from "../WebsocketMessages";
import { parseToRgb, toMantineColor } from "../components/colorUtils";
import {
  Box,
  Checkbox,
  Flex,
  ScrollArea,
  Select,
  TextInput,
  Tooltip,
  ColorInput,
  useMantineTheme,
  useMantineColorScheme,
  Popover,
} from "@mantine/core";

// Kept stable across renders so Mantine widgets don't see a fresh styles
// object every time and re-run their internal style memos.
const PROP_INPUT_STYLES = {
  input: { height: "1.625rem", minHeight: "1.625rem", width: "100%" },
};
const PROP_INPUT_FILL = { width: "100%" };

// Bumped above the surrounding popover so dropdowns and color pickers
// don't get clipped. Matches the convention used in components/Rgb.tsx
// and components/Dropdown.tsx. Offset is tightened so the options list
// sits closer to the input.
const PROP_INPUT_DROPDOWN_PROPS = { zIndex: 1000, offset: 4 };

// "FrameMessage" -> "Frame", "Gui3DMessage" -> "Gui 3D", etc. Used both for
// the popover header and the pencil-button tooltip on each row.
function messageTypeToLabel(messageType: string): string {
  return messageType
    .replace("Message", "")
    .replace(/([a-z])(\d[A-Z])/g, "$1 $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .trim();
}

function TsTypeTooltip({
  tsType,
  children,
}: {
  tsType: string;
  children: React.ReactElement;
}) {
  if (!tsType) return children;
  return (
    <Tooltip
      label={tsType}
      withinPortal
      zIndex={1000}
      openDelay={300}
      multiline
      style={{ fontFamily: "monospace", maxWidth: "20em" }}
    >
      {children}
    </Tooltip>
  );
}

function PropInput({
  propKey,
  descriptor,
  form,
  initialValues,
  stringify,
  parse,
  submit,
  submitField,
}: {
  propKey: string;
  descriptor: ScenePropDescriptor;
  form: ReturnType<typeof useForm<Record<string, string>>>;
  initialValues: Record<string, string>;
  stringify: (value: any) => string;
  parse: (value: string) => any;
  submit: () => void;
  submitField: (key: string) => void;
}) {
  const stringValue = form.values[propKey];

  const tsType = descriptor.tsType;
  switch (descriptor.kind) {
    case "boolean": {
      return (
        <TsTypeTooltip tsType={tsType}>
          <Checkbox
            size="xs"
            radius="xs"
            checked={stringValue === "true"}
            onChange={(evt) => {
              form.setFieldValue(propKey, stringify(evt.currentTarget.checked));
              // Submit only this field: a whole-form submit would be blocked by
              // an unrelated text field left mid-edit with invalid JSON.
              submitField(propKey);
            }}
          />
        </TsTypeTooltip>
      );
    }

    case "stringLiteral": {
      let current: string | null = null;
      try {
        const parsed = parse(stringValue);
        if (typeof parsed === "string") current = parsed;
      } catch (e) {
        // Leave current=null so Select shows a placeholder.
      }
      return (
        <TsTypeTooltip tsType={tsType}>
          <Select
            size="xs"
            radius="xs"
            data={descriptor.options as unknown as string[]}
            value={current}
            allowDeselect={false}
            styles={PROP_INPUT_STYLES}
            style={PROP_INPUT_FILL}
            comboboxProps={PROP_INPUT_DROPDOWN_PROPS}
            onChange={(next) => {
              if (next === null) return;
              form.setFieldValue(propKey, stringify(next));
              submitField(propKey);
            }}
          />
        </TsTypeTooltip>
      );
    }

    case "color": {
      // Always render the picker -- even if the current form text is mid-edit
      // and not a valid 3-tuple, fall back to black so the widget stays usable.
      let hex = "#000000";
      try {
        const parsed = parse(stringValue);
        if (
          Array.isArray(parsed) &&
          parsed.length === 3 &&
          parsed.every((v) => typeof v === "number")
        ) {
          hex = toMantineColor(parsed as [number, number, number]) ?? hex;
        }
      } catch (e) {
        // Keep default hex.
      }
      return (
        <TsTypeTooltip tsType={tsType}>
          <ColorInput
            size="xs"
            styles={PROP_INPUT_STYLES}
            style={PROP_INPUT_FILL}
            popoverProps={PROP_INPUT_DROPDOWN_PROPS}
            value={hex}
            onChange={(nextHex) => {
              const rgb = parseToRgb(nextHex);
              if (rgb === null) return;
              form.setFieldValue(propKey, stringify(rgb));
              submitField(propKey);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitField(propKey);
              }
            }}
          />
        </TsTypeTooltip>
      );
    }

    default: {
      const isDirty = stringValue !== initialValues[propKey];
      return (
        <TsTypeTooltip tsType={tsType}>
          <TextInput
            size="xs"
            styles={PROP_INPUT_STYLES}
            style={PROP_INPUT_FILL}
            {...form.getInputProps(propKey)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
            rightSection={
              <IconDeviceFloppy
                style={{
                  width: "1rem",
                  height: "1rem",
                  opacity: isDirty ? 1.0 : 0.3,
                  cursor: isDirty ? "pointer" : "default",
                }}
                onClick={() => {
                  if (isDirty) submit();
                }}
              />
            }
          />
        </TsTypeTooltip>
      );
    }
  }
}

function EditNodeProps({
  nodeName,
  closePopoverFn,
}: {
  nodeName: string;
  closePopoverFn: () => void;
}) {
  const viewer = React.useContext(ViewerContext)!;
  const nodeMessage = viewer.useSceneTree(nodeName, (node) => node?.message);

  if (nodeMessage === undefined) {
    return null;
  }
  return (
    <EditNodePropsInner
      nodeName={nodeName}
      nodeMessage={nodeMessage}
      updateSceneNode={viewer.sceneTreeActions.updateSceneNodeProps}
      closePopoverFn={closePopoverFn}
    />
  );
}

function EditNodePropsInner({
  nodeName,
  nodeMessage,
  updateSceneNode,
  closePopoverFn,
}: {
  nodeName: string;
  nodeMessage: SceneNode["message"];
  updateSceneNode: (
    name: string,
    props: Record<string, unknown>,
  ) => void;
  closePopoverFn: () => void;
}) {

  // We'll use JSON, but add support for Infinity.
  // We use infinity for point cloud rendering norms.
  function stringify(value: any) {
    if (value == Number.POSITIVE_INFINITY) {
      return "Infinity";
    } else {
      return JSON.stringify(value);
    }
  }
  function parse(value: string) {
    if (value === "Infinity") {
      return Number.POSITIVE_INFINITY;
    } else {
      return JSON.parse(value);
    }
  }

  const props = nodeMessage.props;
  const initialValues = Object.fromEntries(
    Object.entries(props)
      .filter(([, value]) => !ArrayBuffer.isView(value))
      .map(([key, value]) => [key, stringify(value)]),
  );

  const form = useForm({
    initialValues: {
      ...initialValues,
    },
    validate: {
      ...Object.fromEntries(
        Object.keys(initialValues).map((key) => [
          key,
          (value: string) => {
            try {
              parse(value);
              return null;
            } catch (e) {
              return "Invalid JSON";
            }
          },
        ]),
      ),
    },
  });

  // Sync the form when the server changes props (the footer promises "Updates
  // from the server will overwrite local changes"). Mantine's useForm only
  // reads initialValues at mount, so we push server-changed fields in here.
  //
  // We update ONLY the fields whose server value actually changed -- not a full
  // form reset / remount -- so an in-progress edit of an unrelated field isn't
  // discarded, and the popover doesn't churn (lose focus / close dropdowns) on
  // every prop tick. `nodeMessage` identity changes only on prop updates (pose
  // and visibility updates don't touch it), so this effect is keyed on it.
  const prevInitialValuesRef = React.useRef(initialValues);
  React.useEffect(() => {
    const prev = prevInitialValuesRef.current;
    for (const key of Object.keys(initialValues)) {
      if (initialValues[key] !== prev[key]) {
        form.setFieldValue(key, initialValues[key]);
      }
    }
    prevInitialValuesRef.current = initialValues;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeMessage]);

  const handleSubmit = (values: Record<string, string>) => {
    Object.entries(values).forEach(([key, value]) => {
      if (value !== initialValues[key]) {
        try {
          const parsedValue = parse(value);
          updateSceneNode(nodeName, { [key]: parsedValue });
          // Update the form value to match the parsed value.
          form.setFieldValue(key, stringify(parsedValue));
        } catch (e) {
          console.error("Failed to parse JSON:", e);
        }
      }
    });
  };

  // Submit a single field, bypassing Mantine's whole-form validation. Used by
  // the auto-submitting inputs (boolean/select/color) so a change isn't silently
  // dropped when an unrelated text field is mid-edit with invalid JSON.
  const submitField = (key: string) => {
    try {
      // getValues() (not the reactive `form.values` snapshot) so we read the
      // value just set by the caller's setFieldValue in the same handler.
      const parsedValue = parse(form.getValues()[key]);
      updateSceneNode(nodeName, { [key]: parsedValue });
      form.setFieldValue(key, stringify(parsedValue));
    } catch (e) {
      console.error("Failed to parse JSON:", e);
    }
  };

  return (
    <Box
      className={propsWrapper}
      component="form"
      data-props-popover-for={nodeName}
      onSubmit={form.onSubmit(handleSubmit)}
      w="15em"
    >
      <Box>
        <Box
          style={{
            display: "flex",
            alignItems: "center",
          }}
        >
          <Box style={{ fontWeight: "500", flexGrow: "1" }} fz="sm">
            {messageTypeToLabel(nodeMessage.type)} Props
          </Box>
          <Tooltip label={"Close props"}>
            <IconX
              style={{
                cursor: "pointer",
                width: "1em",
                height: "1em",
                display: "block",
                opacity: "0.7",
              }}
              onClick={(evt) => {
                evt.stopPropagation();
                closePopoverFn();
              }}
            />
          </Tooltip>
        </Box>
        <Box style={{ opacity: "0.5" }} fz="xs">
          {nodeName}
        </Box>
      </Box>
      <ScrollArea.Autosize
        mah="30vh"
        scrollbarSize={6}
        offsetScrollbars="present"
        type="auto"
      >
        <Box
          style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}
        >
          {(() => {
            const messageDescriptors =
              SceneNodePropsSchema[nodeMessage.type] ?? {};
            return Object.entries(props).map(([key, value]) => {
              if (key.startsWith("_")) return null;
              if (messageDescriptors[key]?.editorHidden) return null;

              const label =
                key.charAt(0).toUpperCase() + key.slice(1).split("_").join(" ");

              if (ArrayBuffer.isView(value)) {
                return (
                  <Flex key={key} align="center" data-prop-key={key}>
                    <Box style={{ flexGrow: "1" }} fz="xs">
                      {label}
                    </Box>
                    <Flex gap="xs" style={{ width: "9em", flexShrink: 0 }}>
                      <TsTypeTooltip tsType="(typed array)">
                        <TextInput
                          size="xs"
                          disabled
                          styles={PROP_INPUT_STYLES}
                          value={`${value.constructor.name}[${(value as ArrayBufferView & { length: number }).length}]`}
                        />
                      </TsTypeTooltip>
                    </Flex>
                  </Flex>
                );
              }

              const descriptor: ScenePropDescriptor = messageDescriptors[
                key
              ] ?? { kind: "default", tsType: "" };

            return (
              <Flex key={key} align="center" data-prop-key={key}>
                <Box style={{ flexGrow: "1" }} fz="xs">
                  {label}
                </Box>
                <Flex gap="xs" style={{ width: "9em", flexShrink: 0 }}>
                  <PropInput
                    propKey={key}
                    descriptor={descriptor}
                    form={form}
                    initialValues={initialValues}
                    stringify={stringify}
                    parse={parse}
                    submit={() => form.onSubmit(handleSubmit)()}
                    submitField={submitField}
                  />
                </Flex>
              </Flex>
              );
            });
          })()}
        </Box>
      </ScrollArea.Autosize>
      <Box style={{ opacity: "0.4", marginTop: "0.25rem" }} fz="xs">
        Updates from the server will overwrite local changes.
      </Box>
    </Box>
  );
}

/* Table for seeing an overview of the scene tree, toggling visibility, etc. * */
export default function SceneTreeTable() {
  const viewer = React.useContext(ViewerContext)!;
  const childrenName = viewer.useSceneTree(
    "",
    (node) => node!.children,
    shallowArrayEqual,
  );
  return (
    <ScrollArea className={tableWrapper}>
      <PropsPopoverProvider>
        <VisibilityPaintProvider>
          {childrenName.map((name) => (
            <SceneTreeTableRow nodeName={name} key={name} indentCount={0} />
          ))}
        </VisibilityPaintProvider>
      </PropsPopoverProvider>
    </ScrollArea>
  );
}

const VisibilityPaintContext = React.createContext<{
  paintingRef: React.MutableRefObject<boolean>;
  paintValueRef: React.MutableRefObject<boolean>;
  startPainting: (value: boolean) => void;
  stopPainting: () => void;
} | null>(null);

const PropsPopoverContext = React.createContext<{
  openPopoverNodeName: string | null;
  setOpenPopoverNodeName: (nodeName: string | null) => void;
} | null>(null);

export function VisibilityPaintProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const paintingRef = React.useRef(false);
  const paintValueRef = React.useRef(false);

  // Stable identities so the context value below doesn't re-create every render
  // (which would cascade re-renders to every consumer) and the mouseup effect
  // below doesn't tear down + re-attach its listener on each render. Both
  // functions only mutate refs, so they have no reactive deps.
  const startPainting = React.useCallback((value: boolean) => {
    paintingRef.current = true;
    paintValueRef.current = value;
  }, []);

  const stopPainting = React.useCallback(() => {
    paintingRef.current = false;
  }, []);

  React.useEffect(() => {
    window.addEventListener("mouseup", stopPainting);
    return () => {
      window.removeEventListener("mouseup", stopPainting);
    };
  }, [stopPainting]);

  return (
    <VisibilityPaintContext.Provider
      value={{ paintingRef, paintValueRef, startPainting, stopPainting }}
    >
      {children}
    </VisibilityPaintContext.Provider>
  );
}

export function PropsPopoverProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [openPopoverNodeName, setOpenPopoverNodeName] = React.useState<
    string | null
  >(null);

  return (
    <PropsPopoverContext.Provider
      value={{ openPopoverNodeName, setOpenPopoverNodeName }}
    >
      {children}
    </PropsPopoverContext.Provider>
  );
}

// Modified SceneTreeTableRow.
const SceneTreeTableRow = React.memo(function SceneTreeTableRow(props: {
  nodeName: string;
  indentCount: number;
}) {
  const viewer = React.useContext(ViewerContext)!;
  const theme = useMantineTheme();
  const { colorScheme } = useMantineColorScheme();
  const { paintingRef, paintValueRef, startPainting } = React.useContext(
    VisibilityPaintContext,
  )!;
  const { openPopoverNodeName, setOpenPopoverNodeName } =
    React.useContext(PropsPopoverContext)!;

  const handleVisibilityMouseDown = (evt: React.MouseEvent) => {
    evt.stopPropagation();
    const newValue = !isVisible;
    startPainting(newValue);

    // Update visibility using scene tree state.
    viewer.sceneTreeActions.updateNodeAttributes(props.nodeName, {
      overrideVisibility: newValue,
    });
  };

  const handleVisibilityMouseEnter = () => {
    if (!paintingRef.current) return;

    // Update visibility to match paint value using scene tree state.
    viewer.sceneTreeActions.updateNodeAttributes(props.nodeName, {
      overrideVisibility: paintValueRef.current,
    });
  };

  const childrenName = viewer.useSceneTree(
    props.nodeName,
    (node) => node?.children,
    shallowArrayEqual,
  );
  const messageType = viewer.useSceneTree(
    props.nodeName,
    (node) => node?.message.type,
  );
  const expandable = (childrenName?.length ?? 0) > 0;
  const [expanded, { toggle: toggleExpanded }] = useDisclosure(false);

  // Label visibility is managed in the scene node itself.
  const setLabelVisibility = (visible: boolean) => {
    viewer.sceneTreeActions.updateNodeAttributes(props.nodeName, {
      labelVisible: visible,
    });
  };

  // Get server visibility and override visibility separately.
  // These use default equality (===) which is fine for boolean/undefined.
  const serverVisibility =
    viewer.useSceneTree(props.nodeName, (node) => node?.visibility) ?? true;
  const overrideVisibility = viewer.useSceneTree(
    props.nodeName,
    (node) => node?.overrideVisibility,
  );

  // Compute final visibility: override takes precedence, fallback to server.
  const isVisible =
    overrideVisibility !== undefined ? overrideVisibility : serverVisibility;

  // Get effective visibility (includes parent chain visibility).
  const isVisibleEffective =
    viewer.useSceneTree(props.nodeName, (node) => node?.effectiveVisibility) ??
    false;

  // Ensure label visibility is cleaned up when component unmounts.
  React.useEffect(() => {
    return () => {
      setLabelVisibility(false);
    };
  }, []);

  const VisibleIcon = isVisible ? IconEye : IconEyeOff;

  const closePropsPopover = () => {
    setOpenPopoverNodeName(null);
  };

  const togglePropsPopover = () => {
    if (openPopoverNodeName === props.nodeName) {
      // Close if this node's popup is currently open
      setOpenPopoverNodeName(null);
    } else {
      // Open this node's popup (will close any other open popup)
      setOpenPopoverNodeName(props.nodeName);
    }
  };

  return (
    <>
      <Box
        className={tableRow}
        data-scene-node={props.nodeName}
        style={{
          cursor: expandable ? "pointer" : undefined,
        }}
        onClick={expandable ? toggleExpanded : undefined}
        onMouseEnter={() => setLabelVisibility(true)}
        onMouseLeave={() => setLabelVisibility(false)}
      >
        {new Array(props.indentCount).fill(null).map((_, i) => (
          <Box className={tableHierarchyLine} key={i} />
        ))}
        <Box
          style={{
            opacity: expandable ? 0.7 : 0.1,
          }}
        >
          {expanded ? (
            <IconCaretDown
              style={{
                height: "1em",
                width: "1em",
                transform: "translateY(0.1em)",
              }}
            />
          ) : (
            <IconCaretRight
              style={{
                height: "1em",
                width: "1em",
                transform: "translateY(0.1em)",
              }}
            />
          )}
        </Box>
        <Box style={{ width: "1.5em", height: "1.5em" }}>
          <Tooltip label="Toggle visibility override">
            <VisibleIcon
              style={{
                cursor: "pointer",
                opacity: isVisibleEffective ? 0.85 : 0.25,
                width: "1.5em",
                height: "1.5em",
                display: "block",
                // Add theme color tint when visibility is overridden
                ...(overrideVisibility !== undefined && {
                  color:
                    theme.colors[theme.primaryColor][
                      colorScheme === "dark" ? 4 : 6
                    ],
                  filter: `drop-shadow(0 0 2px ${
                    theme.colors[theme.primaryColor][
                      colorScheme === "dark" ? 4 : 6
                    ]
                  }30)`,
                }),
              }}
              onMouseDown={handleVisibilityMouseDown}
              onMouseEnter={handleVisibilityMouseEnter}
            />
          </Tooltip>
        </Box>
        <Box
          style={{
            flexGrow: "1",
            userSelect: "none",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          <span style={{ opacity: "0.3" }}>/</span>
          {props.nodeName.split("/").at(-1)}
        </Box>
        {overrideVisibility !== undefined ? (
          <Box
            className={editIconWrapper}
            style={{
              width: "1.25em",
              height: "1.25em",
              display: "block",
              transition: "opacity 0.2s",
              marginRight: "0.25em",
            }}
          >
            <Tooltip label="Clear visibility override">
              <IconEyeX
                style={{
                  cursor: "pointer",
                  width: "1.25em",
                  height: "1.25em",
                  display: "block",
                  opacity: 0.7,
                  color:
                    theme.colors[theme.primaryColor][
                      colorScheme === "dark" ? 4 : 6
                    ],
                  filter: `drop-shadow(0 0 2px ${
                    theme.colors[theme.primaryColor][
                      colorScheme === "dark" ? 4 : 6
                    ]
                  }30)`,
                }}
                onClick={(evt) => {
                  evt.stopPropagation();
                  viewer.sceneTreeActions.updateNodeAttributes(props.nodeName, {
                    overrideVisibility: undefined,
                  });
                }}
              />
            </Tooltip>
          </Box>
        ) : null}
        <Popover
          position="bottom"
          withArrow
          shadow="sm"
          arrowSize={10}
          opened={openPopoverNodeName === props.nodeName}
          onDismiss={closePropsPopover}
          middlewares={{ flip: true, shift: true }}
          withinPortal
        >
          <Popover.Target>
            <Box
              className={editIconWrapper}
              style={{
                width: "1.25em",
                height: "1.25em",
                display: "block",
                transition: "opacity 0.2s",
                // Stay visible while this row's popover is open even if the
                // cursor leaves the row.
                ...(openPopoverNodeName === props.nodeName && { opacity: 1 }),
              }}
            >
              <Tooltip
                label={
                  messageType
                    ? `${messageTypeToLabel(messageType)} Props`
                    : "Local Props"
                }
              >
                <IconPencil
                  aria-label={`Edit props for ${props.nodeName}`}
                  style={{
                    cursor: "pointer",
                    width: "1.25em",
                    height: "1.25em",
                    display: "block",
                  }}
                  onClick={(evt) => {
                    evt.stopPropagation();
                    togglePropsPopover();
                  }}
                />
              </Tooltip>
            </Box>
          </Popover.Target>
          <Popover.Dropdown
            // Don't propagate clicks or mouse events. This prevents (i)
            // clicking the popover from expanding rows, and (ii) clicking
            // color inputs from closing the popover.
            onMouseDown={(evt) => evt.stopPropagation()}
            onClick={(evt) => evt.stopPropagation()}
          >
            <EditNodeProps
              nodeName={props.nodeName}
              closePopoverFn={closePropsPopover}
            />
          </Popover.Dropdown>
        </Popover>
      </Box>
      {expanded
        ? childrenName?.map((name) => (
            <SceneTreeTableRow
              nodeName={name}
              key={name}
              indentCount={props.indentCount + 1}
            />
          ))
        : null}
    </>
  );
});
