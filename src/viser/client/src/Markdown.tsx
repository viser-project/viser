import React from "react";
import * as runtime from "react/jsx-runtime";
import * as provider from "@mdx-js/react";
import { evaluate } from "@mdx-js/mdx";
import { type MDXComponents } from "mdx/types";
import { ReactNode, useEffect, useState } from "react";
import remarkGfm from "remark-gfm";
import rehypeColorChips from "rehype-color-chips";
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

// Custom classes to pipe MDX into Mantine Components.
//
// ``size="sm"`` (14px) on Text/Anchor/List is a compromise between
// Mantine's default (16px, too big next to GUI inputs) and the ``xs``
// (12px) used by input components themselves — paragraphs read cleanly
// without feeling cramped. Titles keep their own order-based sizing so
// headings still read as headings.
//
// Some of them separate the children into a separate prop since Mantine
// requires a child and MDX always makes children optional, so
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
  // Account for GFM Checkboxes
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

const components: MDXComponents = {
  p: (props) => MdxText(props),
  a: (props) => MdxAnchor(props),
  h1: (props) => MdxTitle(props, 1),
  h2: (props) => MdxTitle(props, 2),
  h3: (props) => MdxTitle(props, 3),
  h4: (props) => MdxTitle(props, 4),
  h5: (props) => MdxTitle(props, 5),
  h6: (props) => MdxTitle(props, 6),
  ul: (props) => MdxList(props, props.children ?? "", "unordered"),
  ol: (props) => MdxList(props, props.children ?? "", "ordered"),
  li: (props) => MdxListItem(props, props.children ?? ""),
  code: (props) => MdxCode(props, props.children ?? ""),
  pre: (props) => <>{props.children}</>,
  blockquote: (props) => MdxBlockquote(props),
  Cite: (props) => MdxCite(props),
  table: (props) => MdxTable(props),
  img: (props) => MdxImage(props),
  "*": () => <></>,
};

async function parseMarkdown(markdown: string) {
  // @ts-ignore (necessary since JSX runtime isn't properly typed according to the internet)
  const { default: Content } = await evaluate(markdown, {
    ...runtime,
    ...provider,
    development: false,
    remarkPlugins: [remarkGfm],
    rehypePlugins: [rehypeCodeblock, rehypeColorChips],
  });
  return Content;
}

/**
 * Parses and renders markdown on the client. This is generally a bad practice.
 * NOTE: Only run on markdown you trust.
 * It might be worth looking into sandboxing all markdown so that it can't run JS.
 */
export default function Markdown(props: { children?: string }) {
  const [child, setChild] = useState<ReactNode>(null);

  useEffect(() => {
    try {
      parseMarkdown(props.children ?? "").then((Content) => {
        setChild(<Content components={components} />);
      });
    } catch {
      setChild(<Title order={2}>Error Parsing Markdown...</Title>);
    }
  }, [props.children]);

  return child;
}
