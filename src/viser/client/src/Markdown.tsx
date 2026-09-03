import React from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
} from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeColorChips from "rehype-color-chips";
import { rehypeRawDom } from "./rehypeRawDom";
import {
  Anchor,
  Blockquote,
  Code,
  Image,
  List,
  ListProps,
  Table,
  Text,
  Title,
  TitleOrder,
} from "@mantine/core";
import { visit } from "unist-util-visit";
import { Transformer } from "unified";
import { Root } from "hast";

// Custom Rehype to clean up code blocks (Mantine makes these annoying to style)
// Adds "block" to any code non-inline code block, which gets directly passed into
// the Mantine Code component.
function rehypeCodeblock(): void | Transformer<Root, Root> {
  return (tree) => {
    visit(tree, "element", (node, _i, parent) => {
      if (node.tagName !== "code") return;
      if (parent && parent.type === "element" && parent.tagName === "pre") {
        node.properties = { block: true, ...node.properties };
      }
    });
  };
}

// Custom classes to pipe markdown into Mantine Components.
//
// ``size="sm"`` (14px) on Text/Anchor/List is a compromise between
// Mantine's default (16px, too big next to GUI inputs) and the ``xs``
// (12px) used by input components themselves -- paragraphs read cleanly
// without feeling cramped. Titles keep their own order-based sizing so
// headings still read as headings.
//
// Some of them separate the children into a separate prop since Mantine
// requires a child and the renderer always makes children optional, so
// destructuring props doesn't work.
function MdxText(props: React.ComponentPropsWithoutRef<typeof Text>) {
  return <Text size="sm" {...props} />;
}

function MdxAnchor(props: React.ComponentPropsWithoutRef<typeof Anchor>) {
  return <Anchor size="sm" {...props} />;
}

function MdxTitle(
  props: React.ComponentPropsWithoutRef<typeof Title>,
  order: TitleOrder,
) {
  return <Title order={order} {...props}></Title>;
}

function MdxList(
  props: Omit<React.ComponentPropsWithoutRef<typeof List>, "children" | "type">,
  children: React.ComponentPropsWithoutRef<typeof List>["children"],
  type: ListProps["type"],
) {
  // Account for GFM Checkboxes.
  if (props.className == "contains-task-list") {
    return (
      <List size="sm" type={type} {...props} listStyleType="none">
        {children}
      </List>
    );
  }
  return (
    <List size="sm" type={type} {...props}>
      {children}
    </List>
  );
}

function MdxListItem(
  props: Omit<React.ComponentPropsWithoutRef<typeof List.Item>, "children">,
  children: React.ComponentPropsWithoutRef<typeof List.Item>["children"],
) {
  return <List.Item {...props}>{children}</List.Item>;
}

// A possible improvement is to use Mantine Prism to add code highlighting support.
function MdxCode(
  props: Omit<React.ComponentPropsWithoutRef<typeof Code>, "children">,
  children: React.ComponentPropsWithoutRef<typeof Code>["children"],
) {
  return <Code {...props}>{children}</Code>;
}

function MdxBlockquote(
  props: React.ComponentPropsWithoutRef<typeof Blockquote>,
) {
  return <Blockquote {...props} />;
}

function MdxCite(
  props: React.DetailedHTMLProps<
    React.HTMLAttributes<HTMLElement>,
    HTMLElement
  >,
) {
  return (
    <cite
      style={{
        display: "block",
        fontSize: "0.875rem",
        marginTop: "0.625rem",
        color: "#909296",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
      {...props}
    />
  );
}

function MdxTable(props: React.ComponentPropsWithoutRef<typeof Table>) {
  return <Table {...props} highlightOnHover withColumnBorders />;
}

function MdxImage(props: React.ComponentPropsWithoutRef<typeof Image>) {
  return <Image maw={240} mx="auto" radius="md" {...props} />;
}

// react-markdown passes the hast `node` alongside the DOM props; strip it so
// it doesn't leak onto Mantine components / DOM elements.
function dom<T>(props: T & { node?: unknown }): T {
  const rest = { ...props };
  delete (rest as { node?: unknown }).node;
  return rest;
}

// The renderer types component props as intrinsic HTML attributes; the Mantine
// wrappers are structurally compatible for the props markdown actually
// produces (className, children, href, src, ...), so adapt via `any`.
const components: Components = {
  p: (props: any) => MdxText(dom(props)),
  a: (props: any) => MdxAnchor(dom(props)),
  h1: (props: any) => MdxTitle(dom(props), 1),
  h2: (props: any) => MdxTitle(dom(props), 2),
  h3: (props: any) => MdxTitle(dom(props), 3),
  h4: (props: any) => MdxTitle(dom(props), 4),
  h5: (props: any) => MdxTitle(dom(props), 5),
  h6: (props: any) => MdxTitle(dom(props), 6),
  ul: (props: any) => MdxList(dom(props), props.children ?? "", "unordered"),
  ol: (props: any) => MdxList(dom(props), props.children ?? "", "ordered"),
  li: (props: any) => MdxListItem(dom(props), props.children ?? ""),
  code: (props: any) => MdxCode(dom(props), props.children ?? ""),
  pre: (props: any) => <>{props.children}</>,
  blockquote: (props: any) => MdxBlockquote(dom(props)),
  cite: (props: any) => MdxCite(dom(props)),
  table: (props: any) => MdxTable(dom(props)),
  img: (props: any) => MdxImage(dom(props)),
};

/**
 * Renders markdown on the client with GFM support. Unlike the previous
 * MDX-based implementation, markdown is parsed rather than compiled and
 * evaluated as code. Raw HTML in the markdown is still rendered without
 * sanitization (via rehypeRawDom) -- script tags included -- so content must
 * come from a trusted server, exactly as before.
 */
// The server embeds image_root images as data: URIs, which react-markdown's
// default URL transform strips (its allow-list is http/https/mailto/...).
// Content already comes from a trusted server -- raw HTML renders
// unsanitized above -- so pass data: through and keep the default handling
// for every other scheme.
function urlTransform(url: string): string {
  return url.startsWith("data:") ? url : defaultUrlTransform(url);
}

function Markdown(props: { children?: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeRawDom, rehypeCodeblock, rehypeColorChips]}
      components={components}
      urlTransform={urlTransform}
    >
      {props.children ?? ""}
    </ReactMarkdown>
  );
}

// Memoized: parsing runs on every render otherwise, and markdown elements
// often sit inside containers that re-render for unrelated reasons (theme
// changes, sibling GUI updates). With a string child, shallow prop
// comparison makes this exactly "re-parse when content changes".
export default React.memo(Markdown);
