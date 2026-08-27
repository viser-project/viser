/** Rehype plugin that parses raw HTML embedded in markdown using the
 * browser's native HTML parser, replacing `rehype-raw` (which bundles the
 * same spec-compliant parsing as ~140 KiB of parse5 + entities).
 *
 * Raw HTML can span markdown blocks (`<div>` in one block, `</div>` several
 * paragraphs later), so per-fragment parsing isn't enough. Like rehype-raw,
 * we reprocess the whole tree: serialize it back to an HTML string with raw
 * nodes passed through verbatim, parse that string with `DOMParser`, and
 * convert the resulting DOM back to hast. The parser hoists metadata content
 * (`<style>`, `<title>`, ...) into `<head>`, so both head and body children
 * are collected into the output root.
 *
 * Like rehype-raw, this renders raw HTML without sanitization -- markdown
 * must come from a trusted server.
 */
import type { Root, RootContent } from "hast";
import { fromDom } from "hast-util-from-dom";
import { toHtml } from "hast-util-to-html";
import type { Transformer } from "unified";
import { EXIT, visit } from "unist-util-visit";

export function rehypeRawDom(): Transformer<Root, Root> {
  return (tree) => {
    // Trees without raw HTML (the common case) pass through untouched.
    let hasRaw = false;
    visit(tree, "raw", () => {
      hasRaw = true;
      return EXIT;
    });
    if (!hasRaw) return tree;

    const html = toHtml(tree, { allowDangerousHtml: true });
    const doc = new DOMParser().parseFromString(html, "text/html");
    const children: RootContent[] = [];
    for (const domNode of [...doc.head.childNodes, ...doc.body.childNodes]) {
      const hastNode = fromDom(domNode);
      if (hastNode.type !== "root") children.push(hastNode);
    }
    return { type: "root", children };
  };
}
