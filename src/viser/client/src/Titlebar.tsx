import { ViewerContext } from "./ViewerContext";
import { ThemeConfigurationMessage } from "./WebsocketMessages";
import {
  Burger,
  Button,
  Container,
  Group,
  Paper,
  Box,
  useMantineColorScheme,
  Portal,
} from "@mantine/core";
import {
  IconBrandGithub,
  IconFileDescription,
  IconKeyboard,
} from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";
import { useContext } from "react";

// Type helpers.
type ArrayElement<ArrayType extends readonly unknown[]> =
  ArrayType extends readonly (infer ElementType)[] ? ElementType : never;
type TitlebarContent = NonNullable<
  ThemeConfigurationMessage["titlebar_content"]
>;
function assertUnreachable(x: never): never {
  throw new Error("Didn't expect to get here", x);
}

function getIcon(
  icon: ArrayElement<NonNullable<TitlebarContent["buttons"]>>["icon"],
) {
  let Icon = null;
  switch (icon) {
    case null:
      break;
    case "GitHub":
      Icon = IconBrandGithub;
      break;
    case "Description":
      Icon = IconFileDescription;
      break;
    case "Keyboard":
      Icon = IconKeyboard;
      break;
    default:
      assertUnreachable(icon);
  }
  return Icon;
}

// We inherit props directly from message contents.
export function TitlebarButton(
  props: ArrayElement<NonNullable<TitlebarContent["buttons"]>>,
) {
  const Icon = getIcon(props.icon);
  return (
    <Button
      component="a"
      variant="default"
      size="compact-sm"
      href={props.href || undefined}
      target="_blank"
      leftSection={Icon === null ? null : <Icon size="1em" />}
      ml="xs"
      color="gray"
    >
      {props.text}
    </Button>
  );
}

export function MobileTitlebarButton(
  props: ArrayElement<NonNullable<TitlebarContent["buttons"]>>,
) {
  const Icon = getIcon(props.icon);
  return (
    <Button
      m="sm"
      component="a"
      variant="default"
      href={props.href || undefined}
      target="_blank"
      leftSection={Icon === null ? null : <Icon size="1.5em" />}
      ml="sm"
      color="gray"
    >
      {props.text}
    </Button>
  );
}

export function TitlebarImage(
  props: NonNullable<TitlebarContent["image"]>,
  colorScheme: string,
) {
  let imageSource: string;
  if (props.image_url_dark == null || colorScheme === "light") {
    imageSource = props.image_url_light;
  } else {
    imageSource = props.image_url_dark;
  }
  const image = (
    <img
      src={imageSource}
      alt={props.image_alt}
      style={{
        height: "1.8em",
        margin: "0 0.5em",
      }}
    />
  );

  if (props.href == null) {
    return image;
  }
  return (
    <a style={{ display: "block", height: "1.8em" }} href={props.href}>
      {image}
    </a>
  );
}

export function Titlebar() {
  const viewer = useContext(ViewerContext)!;
  const content = viewer.useGui((state) => state.theme.titlebar_content);
  const colorScheme = useMantineColorScheme().colorScheme;

  const [burgerOpen, burgerHandlers] = useDisclosure(false);

  if (content == null) {
    return null;
  }

  const buttons = content.buttons;
  const imageData = content.image;

  return (
    <Box
      style={{
        height: "3.2em",
        margin: 0,
        border: "0",
        zIndex: 10,
      }}
    >
      <Paper shadow="0 0 0.8em 0 rgba(0,0,0,0.1)" style={{ height: "100%" }}>
        <Container
          fluid
          style={() => ({
            height: "100%",
            display: "flex",
            alignItems: "center",
          })}
        >
          <Group style={() => ({ marginRight: "auto" })}>
            {imageData !== null ? TitlebarImage(imageData, colorScheme) : null}
          </Group>
          <Group
            display={{ base: "none", xs: "flex" }}
            style={() => ({
              flexWrap: "nowrap",
              overflowX: "scroll",
              msOverflowStyle: "none",
              scrollbarWidth: "none",
            })}
          >
            {buttons?.map((btn, index) => (
              <TitlebarButton {...btn} key={index} />
            ))}
          </Group>
          <Burger
            size="sm"
            opened={burgerOpen}
            onClick={burgerHandlers.toggle}
            title={!burgerOpen ? "Open navigation" : "Close navigation"}
            display={{ base: "block", xs: "none" }}
          ></Burger>
        </Container>
        <Portal>
          <Paper
            display={{ base: "flex", xs: "none" }}
            radius="0"
            style={{
              flexDirection: "column",
              position: "absolute",
              top: "3.2em",
              zIndex: 2000,
              height: burgerOpen ? "calc(100vh - 2.375em)" : "0",
              width: "100vw",
              transition: "all 0.5s",
              overflow: burgerOpen ? "scroll" : "hidden",
              padding: burgerOpen ? "1rem" : "0",
            }}
          >
            {buttons?.map((btn, index) => (
              <MobileTitlebarButton {...btn} key={index} />
            ))}
          </Paper>
        </Portal>
      </Paper>
    </Box>
  );
}
