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
import { shallowArrayEqual } from "../utils/shallowArrayEqual";
import {
  Box,
  Flex,
  ScrollArea,
  TextInput,
  Tooltip,
  ColorInput,
  useMantineTheme,
  useMantineColorScheme,
  Popover,
} from "@mantine/core";

function EditNodeProps({
  nodeName,
  closePopoverFn,
}: {
  nodeName: string;
  closePopoverFn: () => void;
}) {
  const viewer = React.useContext(ViewerContext)!;
  const nodeMessage = viewer.useSceneTree(nodeName, (node) => node?.message);
  const updateSceneNode = viewer.sceneTreeActions.updateSceneNodeProps;

  if (nodeMessage === undefined) {
    return null;
  }

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

            const label =
              key.charAt(0).toUpperCase() + key.slice(1).split("_").join(" ");

            // Show typed arrays as read-only type + length.
            if (ArrayBuffer.isView(value)) {
              return (
                <Flex key={key} align="center">
                  <Box style={{ flexGrow: "1" }} fz="xs">
                    {label}
                  </Box>
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

            const isDirty = form.values[key] !== initialValues[key];

            return (
              <Flex key={key} align="center">
                <Box style={{ flexGrow: "1" }} fz="xs">
                  {label}
                </Box>
                <Flex gap="xs" style={{ width: "9em", flexShrink: 0 }}>
                  {(() => {
                    // Check if this is a color property
                    try {
                      const parsedValue = parse(form.values[key]);
                      const isColorProp =
                        key.toLowerCase().includes("color") &&
                        Array.isArray(parsedValue) &&
                        parsedValue.length === 3 &&
                        parsedValue.every((v) => typeof v === "number");

                      if (isColorProp) {
                        // Convert RGB array [0-1] to hex color
                        const rgbToHex = (r: number, g: number, b: number) => {
                          const toHex = (n: number) => {
                            const hex = Math.round(n).toString(16);
                            return hex.length === 1 ? "0" + hex : hex;
                          };
                          return "#" + toHex(r) + toHex(g) + toHex(b);
                        };

                        // Convert hex color to RGB array [0-1]
                        const hexToRgb = (hex: string) => {
                          const r = parseInt(hex.slice(1, 3), 16);
                          const g = parseInt(hex.slice(3, 5), 16);
                          const b = parseInt(hex.slice(5, 7), 16);
                          return [r, g, b];
                        };

                        return (
                          <ColorInput
                            size="xs"
                            styles={{
                              input: {
                                height: "1.625rem",
                                minHeight: "1.625rem",
                              },
                              // icon: { transform: "scale(0.8)" },
                            }}
                            style={{ width: "100%" }}
                            value={rgbToHex(
                              parsedValue[0],
                              parsedValue[1],
                              parsedValue[2],
                            )}
                            onChange={(hex) => {
                              const rgb = hexToRgb(hex);
                              form.setFieldValue(key, stringify(rgb));
                              form.onSubmit(handleSubmit)();
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                form.onSubmit(handleSubmit)();
                              }
                            }}
                          />
                        );
                      }
                    } catch (e) {
                      // If parsing fails, fall back to TextInput
                    }

                    // Default TextInput for non-color properties
                    return (
                      <TextInput
                        size="xs"
                        styles={{
                          input: {
                            height: "1.625rem",
                            minHeight: "1.625rem",
                            width: "100%",
                          },
                          // icon: { transform: "scale(0.8)" },
                        }}
                        style={{ width: "100%" }}
                        {...form.getInputProps(key)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            form.onSubmit(handleSubmit)();
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
                              if (isDirty) {
                                form.onSubmit(handleSubmit)();
                              }
                            }}
                          />
                        }
                      />
                    );
                  })()}
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

  const startPainting = (value: boolean) => {
    paintingRef.current = true;
    paintValueRef.current = value;
  };

  const stopPainting = () => {
    paintingRef.current = false;
  };

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
