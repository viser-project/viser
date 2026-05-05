import { globalStyle, style } from "@vanilla-extract/css";
import { vars } from "../AppTheme";

export const tableWrapper = style({
  borderRadius: vars.radius.xs,
  padding: "0.1em 0",
  overflowX: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "0",
});

export const propsWrapper = style({
  position: "relative",
  boxSizing: "border-box",
  overflowX: "auto",
  display: "flex",
  flexDirection: "column",
  gap: vars.spacing.xs,
});

export const editIconWrapper = style({
  opacity: "0",
});

export const tableRow = style({
  display: "flex",
  alignItems: "center",
  gap: "0.2em",
  padding: "0 0.25em",
  lineHeight: "2em",
  fontSize: "0.875em",
  ":hover": {
    [vars.lightSelector]: {
      backgroundColor: vars.colors.gray[1],
    },
    [vars.darkSelector]: {
      backgroundColor: vars.colors.dark[6],
    },
  },
});

export const tableHierarchyLine = style({
  [vars.lightSelector]: {
    borderColor: vars.colors.gray[2],
  },
  [vars.darkSelector]: {
    borderColor: vars.colors.dark[5],
  },
  borderLeft: "0.3em solid",
  width: "0.2em",
  marginLeft: "0.375em",
  height: "2em",
});

globalStyle(`${tableRow}:hover ${tableHierarchyLine}`, {
  [vars.lightSelector]: {
    borderColor: vars.colors.gray[3],
  },
  [vars.darkSelector]: {
    borderColor: vars.colors.dark[4],
  },
});

globalStyle(`${tableRow}:hover ${editIconWrapper}`, {
  opacity: "1.0",
});
