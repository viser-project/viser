import {
  Checkbox,
  Collapse,
  ColorInput,
  Select,
  TextInput,
  NumberInput,
  Paper,
  ActionIcon,
  Button,
  createTheme,
  Textarea,
} from "@mantine/core";
import { themeToVars } from "@mantine/vanilla-extract";

export const theme = createTheme({
  // System font stack: no font is embedded in the client bundle. Keep in
  // sync with index.css and label/GlyphAtlas.ts.
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", "Roboto", "Helvetica Neue", Arial, sans-serif',
  autoContrast: true,
  // Preserve the Mantine 8 look: v9 changed defaultRadius sm -> md and the
  // `medium` font weight 500 -> 600 across components.
  defaultRadius: "sm",
  fontWeights: {
    medium: "500",
  },
  components: {
    // Mantine 9's Collapse hides collapsed content with <Activity>, which
    // unmounts effects in the hidden subtree (e.g. an upload-progress
    // notification driven from a collapsed panel would freeze). Mantine 8
    // kept collapsed content mounted with effects running via display:none;
    // preserve that behavior.
    Collapse: Collapse.extend({
      defaultProps: {
        keepMountedMode: "display-none",
      },
    }),
    Checkbox: Checkbox.extend({
      defaultProps: {
        radius: "xs",
      },
    }),
    ColorInput: ColorInput.extend({
      defaultProps: {
        radius: "xs",
      },
    }),
    Select: Select.extend({
      defaultProps: {
        radius: "sm",
      },
    }),
    Textarea: Textarea.extend({
      defaultProps: {
        radius: "xs",
      },
    }),
    TextInput: TextInput.extend({
      defaultProps: {
        radius: "xs",
      },
    }),
    NumberInput: NumberInput.extend({
      defaultProps: {
        radius: "xs",
      },
    }),
    Paper: Paper.extend({
      defaultProps: {
        radius: "xs",
        shadow: "0",
      },
    }),
    ActionIcon: ActionIcon.extend({
      defaultProps: {
        variant: "subtle",
        color: "gray",
        radius: "xs",
      },
    }),
    Button: Button.extend({
      defaultProps: {
        radius: "xs",
        styles: {
          label: {
            fontWeight: 450,
          },
        },
      },
    }),
  },
});

export const vars = themeToVars(theme);
