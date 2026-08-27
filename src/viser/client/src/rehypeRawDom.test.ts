// @vitest-environment jsdom
//
// jsdom provides the DOMParser that rehypeRawDom uses in the browser. jsdom's
// HTML parser is parse5 -- the exact parser rehype-raw bundled -- so parity
// assertions here compare against the old behavior, not an approximation.
import type { Element, Root, RootContent, Text } from "hast";
import { describe, expect, it } from "vitest";
import { rehypeRawDom } from "./rehypeRawDom";

function run(tree: Root): Root {
  const result = rehypeRawDom()(tree, null as never, null as never);
  return result as Root;
}

function root(...children: RootContent[]): Root {
  return { type: "root", children };
}

function el(
  tagName: string,
  properties: Element["properties"],
  ...children: Element["children"]
): Element {
  return { type: "element", tagName, properties, children };
}

function text(value: string): Text {
  return { type: "text", value };
}

// The `raw` node type is declared by mdast-util-to-hast's augmentation of
// hast's content maps; a structurally identical literal type keeps this test
// free of imports from transitive dependencies.
function raw(value: string): { type: "raw"; value: string } {
  return { type: "raw", value };
}

/** Find the first element with the given tag name, depth-first. */
function find(node: Root | Element, tagName: string): Element | undefined {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (child.tagName === tagName) return child;
    const nested = find(child, tagName);
    if (nested) return nested;
  }
  return undefined;
}

function textContent(node: Root | Element): string {
  return node.children
    .map((child) => {
      if (child.type === "text") return child.value;
      if (child.type === "element") return textContent(child);
      return "";
    })
    .join("");
}

describe("rehypeRawDom", () => {
  it("returns trees without raw nodes unchanged", () => {
    const tree = root(el("p", {}, text("hello & <world>")));
    expect(run(tree)).toBe(tree);
  });

  it("parses inline raw HTML into elements", () => {
    const result = run(
      root(el("p", {}, text("press "), raw("<kbd>K</kbd>"), text(" now"))),
    );
    const kbd = find(result, "kbd");
    expect(kbd).toBeDefined();
    expect(textContent(kbd!)).toBe("K");
    expect(textContent(result)).toBe("press K now");
  });

  it("wraps markdown blocks inside raw HTML spanning multiple blocks", () => {
    // Markdown like: <div class="wrap">\n\n*text*\n\n</div>
    const result = run(
      root(
        raw('<div class="wrap">'),
        el("p", {}, el("em", {}, text("text"))),
        raw("</div>"),
      ),
    );
    const div = find(result, "div");
    expect(div?.properties.className).toEqual(["wrap"]);
    expect(find(div!, "p")).toBeDefined();
    expect(find(div!, "em")).toBeDefined();
  });

  it("round-trips markdown-generated elements and their properties", () => {
    const result = run(
      root(
        raw("<span></span>"),
        el(
          "pre",
          {},
          el("code", { className: ["language-python"] }, text("x < 1 & 2")),
        ),
        el("input", { type: "checkbox", checked: true, disabled: true }),
      ),
    );
    const code = find(result, "code");
    expect(code?.properties.className).toEqual(["language-python"]);
    expect(textContent(code!)).toBe("x < 1 & 2");
    const input = find(result, "input");
    expect(input?.properties.checked).toBe(true);
    expect(input?.properties.disabled).toBe(true);
  });

  it("preserves attributes on raw elements", () => {
    const result = run(
      root(raw('<p id="a" style="color: red" data-x="1">hi</p>')),
    );
    const p = find(result, "p");
    expect(p?.properties.id).toBe("a");
    expect(p?.properties.style).toBe("color: red");
    expect(p?.properties.dataX).toBe("1");
  });

  it("keeps metadata content that the parser hoists into <head>", () => {
    const result = run(
      root(raw("<style>b { color: red; }</style>"), el("p", {}, text("hi"))),
    );
    const style = find(result, "style");
    expect(style).toBeDefined();
    expect(textContent(style!)).toContain("color: red");
    expect(find(result, "p")).toBeDefined();
  });

  it("builds proper table structure from raw table fragments", () => {
    const result = run(root(raw("<table><tr><td>cell</td></tr></table>")));
    const td = find(result, "td");
    expect(td).toBeDefined();
    expect(textContent(td!)).toBe("cell");
  });

  it("never renders HTML comments as text", () => {
    // Comments either survive as (unrendered) comment nodes or are dropped
    // by the parser; both are invisible. What must not happen is the comment
    // showing up as literal text.
    const result = run(
      root(
        raw("<!-- before -->"),
        el("p", {}, text("hi"), raw("<!-- after -->")),
      ),
    );
    expect(textContent(result)).toBe("hi");
  });

  it("parses inline SVG with camelCase attributes", () => {
    const result = run(
      root(
        raw(
          '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"></circle></svg>',
        ),
      ),
    );
    const svg = find(result, "svg");
    expect(svg?.properties.viewBox).toBe("0 0 10 10");
    expect(find(svg!, "circle")).toBeDefined();
  });
});
