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
import {
  Box,
  Flex,
  ScrollArea,
  Select,
  Switch,
  TextInput,
  Tooltip,
  ColorInput,
  useMantineTheme,
  useMantineColorScheme,
  Popover,
} from "@mantine/core";

function PropLabel({ label, tsType }: { label: string; tsType: string }) {
  // The TS annotation goes on hover so the user can see the underlying type
  // (e.g. `'square' | 'diamond' | ...`) without having to read the source.
  const inner = (
    <Box style={{ flexGrow: "1" }} fz="xs">
      {label}
    </Box>
  );
  if (!tsType) return inner;
  return (
    <Tooltip
      label={tsType}
      withArrow
      openDelay={300}
      multiline
      style={{ fontFamily: "monospace", maxWidth: "20em" }}
    >
      {inner}
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
}: {
  propKey: string;
  descriptor: ScenePropDescriptor;
  form: ReturnType<typeof useForm<Record<string, string>>>;
  initialValues: Record<string, string>;
  stringify: (value: any) => string;
  parse: (value: string) => any;
  submit: () => void;
}) {
  const stringValue = form.values[propKey];
  const inputStyles = {
    input: { height: "1.625rem", minHeight: "1.625rem", width: "100%" },
  };

  switch (descriptor.kind) {
    case "boolean": {
      // The form keeps every value JSON-stringified for uniform validation,
      // so we encode booleans as "true"/"false" strings here too.
      const checked = stringValue === "true";
      return (
        <Switch
          size="xs"
          checked={checked}
          onChange={(evt) => {
            form.setFieldValue(propKey, stringify(evt.currentTarget.checked));
            submit();
          }}
          styles={{
            root: { width: "100%", display: "flex", justifyContent: "flex-end" },
          }}
        />
      );
    }

    case "stringLiteral": {
      // form value is JSON-stringified, so it carries the surrounding quotes.
      let current: string | null = null;
      try {
        const parsed = parse(stringValue);
        if (typeof parsed === "string") current = parsed;
      } catch (e) {
        // leave null; Select will show placeholder
      }
      return (
        <Select
          size="xs"
          radius="xs"
          data={descriptor.options as unknown as string[]}
          value={current}
          allowDeselect={false}
          styles={inputStyles}
          style={{ width: "100%" }}
          onChange={(next) => {
            if (next === null) return;
            form.setFieldValue(propKey, stringify(next));
            submit();
          }}
        />
      );
    }

    case "color": {
      // Always render a ColorInput when the schema says it's a color, even
      // if the current form text is mid-edit and not a valid 3-tuple. We
      // fall back to black so the picker stays usable.
      const rgbToHex = (r: number, g: number, b: number) => {
        const toHex = (n: number) => {
          const clamped = Math.max(0, Math.min(255, Math.round(n)));
          return clamped.toString(16).padStart(2, "0");
        };
        return "#" + toHex(r) + toHex(g) + toHex(b);
      };
      const hexToRgb = (hex: string) => [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
      ];

      let hex = "#000000";
      try {
        const parsed = parse(stringValue);
        if (
          Array.isArray(parsed) &&
          parsed.length === 3 &&
          parsed.every((v) => typeof v === "number")
        ) {
          // Schema currently only emits scale "0-255"; the branch is here
          // for the day someone adds 0-1 floats.
          const [r, g, b] =
            descriptor.scale === "0-1"
              ? [parsed[0] * 255, parsed[1] * 255, parsed[2] * 255]
              : (parsed as [number, number, number]);
          hex = rgbToHex(r, g, b);
        }
      } catch (e) {
        // keep default hex
      }
      return (
        <ColorInput
          size="xs"
          styles={inputStyles}
          style={{ width: "100%" }}
          value={hex}
          onChange={(nextHex) => {
            const rgb = hexToRgb(nextHex);
            const value =
              descriptor.scale === "0-1"
                ? rgb.map((v) => v / 255)
                : rgb;
            form.setFieldValue(propKey, stringify(value));
            submit();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
        />
      );
    }

    default: {
      const isDirty = stringValue !== initialValues[propKey];
      return (
        <TextInput
          size="xs"
          styles={inputStyles}
          style={{ width: "100%" }}
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

  const handleSubmit = (values: Record<string, string>) => {
    Object.entries(values).forEach(([key, value]) => {
      if (value !== initialValues[key]) {
        try {
          const parsedValue = parse(value);
          updateSceneNode(nodeName, { [key]: parsedValue });
          // Update the form value to match the parsed value
          form.setFieldValue(key, stringify(parsedValue));
        } catch (e) {
          console.error("Failed to parse JSON:", e);
        }
      }
    });
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
            {nodeMessage.type
              .replace("Message", "")
              // First, handle patterns like "Gui3D" -> "Gui 3D" (lowercase + digit + uppercase)
              .replace(/([a-z])(\d[A-Z])/g, "$1 $2")
              // Then handle remaining camelCase patterns like "DContainer" -> "D Container"
              .replace(/([a-z])([A-Z])/g, "$1 $2")
              .trim()}{" "}
            Props
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
          {Object.entries(props).map(([key, value]) => {
            // Skip properties that start with "_".
            if (key.startsWith("_")) {
              return null;
            }

            // Skip props the schema marks as editor-hidden (e.g. PointCloud
            // precision is coupled to the dtype of `points` and can't be
            // edited in isolation).
            const messageDescriptor = SceneNodePropsSchema[nodeMessage.type];
            if (messageDescriptor?.[key]?.editorHidden) {
              return null;
            }

            const label =
              key.charAt(0).toUpperCase() + key.slice(1).split("_").join(" ");

            // Show typed arrays as read-only type + length.
            if (ArrayBuffer.isView(value)) {
              return (
                <Flex key={key} align="center" data-prop-key={key}>
                  <PropLabel label={label} tsType="(typed array)" />
                  <Flex gap="xs" style={{ width: "9em", flexShrink: 0 }}>
                    <TextInput
                      size="xs"
                      disabled
                      styles={{
                        input: {
                          height: "1.625rem",
                          minHeight: "1.625rem",
                          width: "100%",
                        },
                      }}
                      value={`${value.constructor.name}[${(value as ArrayBufferView & { length: number }).length}]`}
                    />
                  </Flex>
                </Flex>
              );
            }

            const descriptor: ScenePropDescriptor = SceneNodePropsSchema[
              nodeMessage.type
            ]?.[key] ?? { kind: "default", tsType: "" };

            return (
              <Flex key={key} align="center" data-prop-key={key}>
                <PropLabel label={label} tsType={descriptor.tsType} />
                <Flex gap="xs" style={{ width: "9em", flexShrink: 0 }}>
                  <PropInput
                    propKey={key}
                    descriptor={descriptor}
                    form={form}
                    initialValues={initialValues}
                    stringify={stringify}
                    parse={parse}
                    submit={() => form.onSubmit(handleSubmit)()}
                  />
                </Flex>
              </Flex>
            );
          })}
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

// Modified SceneTreeTableRow
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
  const expandable = (childrenName?.length ?? 0) > 0;
  const [expanded, { toggle: toggleExpanded }] = useDisclosure(false);

  // Label visibility is managed in the scene node itself
  const setLabelVisibility = (visible: boolean) => {
    viewer.sceneTreeActions.updateNodeAttributes(props.nodeName, {
      labelVisible: visible,
    });
  };

  // Get server visibility and override visibility separately
  // These use default equality (===) which is fine for boolean/undefined
  const serverVisibility =
    viewer.useSceneTree(props.nodeName, (node) => node?.visibility) ?? true;
  const overrideVisibility = viewer.useSceneTree(
    props.nodeName,
    (node) => node?.overrideVisibility,
  );

  // Compute final visibility: override takes precedence, fallback to server
  const isVisible =
    overrideVisibility !== undefined ? overrideVisibility : serverVisibility;

  // Get effective visibility (includes parent chain visibility)
  const isVisibleEffective =
    viewer.useSceneTree(props.nodeName, (node) => node?.effectiveVisibility) ??
    false;

  // Ensure label visibility is cleaned up when component unmounts
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
              }}
            >
              <Tooltip label={"Local props"}>
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
