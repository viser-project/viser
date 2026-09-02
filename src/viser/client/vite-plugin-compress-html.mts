/**
 * Simple Vite plugin to compress the inlined HTML output.
 * Uses zstd compression with embedded WASM decoder for decompression at runtime.
 *
 * This is a simplified alternative to vite-plugin-singlefile-compression
 * that doesn't add problematic import.meta.url polyfills.
 *
 * Layout of the compressed file:
 * - The inline <style> and <script type="module"> bodies are concatenated and
 *   compressed as a single zstd frame, so shared content between CSS and JS
 *   deduplicates and the entropy tables are shared.
 * - The compressed frame is stored base64-encoded in a data attribute and
 *   decoded NATIVELY at startup (Uint8Array.fromBase64, falling back to a
 *   fetch() of a data: URL). An earlier base-88 encoding was 6% smaller on
 *   disk, but needed a hand-written JS decode loop that ran once, cold, on
 *   the critical path (~25-40 ms desktop, more on mobile) -- and because the
 *   server gzips index.html, the wire size was actually ~10 KB LARGER than
 *   base64 (byte-aligned base64 deflates better than base-88).
 * - The zstd WASM decoder bootstraps via gzip (native DecompressionStream).
 */

import { Plugin } from "vite";
import {
  gzipSync,
  zstdCompressSync,
  zstdDecompressSync,
  constants,
} from "zlib";
import { readFileSync } from "fs";
import { dirname, join } from "path";

// Drop CSS rules for Mantine components the bundle never references.
// Mantine class names are static hashes (.m_xxxxxxxx) that appear as string
// literals in the JS of every component that uses them, so a rule whose
// selector only targets hashes absent from the JS is dead. Rules without
// Mantine hashes (resets, CSS variables, app styles) are always kept;
// conditional group rules (@media etc.) are pruned recursively and other
// at-rules (@keyframes, @font-face) are kept whole.
function pruneMantineCss(css: string, js: string): string {
  const usedClasses = new Set(js.match(/m_[0-9a-zA-Z]+/g) ?? []);

  function pruneBlock(block: string): string {
    let out = "";
    let i = 0;
    while (i < block.length) {
      const open = block.indexOf("{", i);
      if (open === -1) {
        out += block.slice(i);
        break;
      }
      let selector = block.slice(i, open);
      // Pass block-less statements (@charset ...;, @import ...;) through.
      const statementsEnd = selector.lastIndexOf(";");
      if (statementsEnd !== -1) {
        out += selector.slice(0, statementsEnd + 1);
        selector = selector.slice(statementsEnd + 1);
      }
      // Find the matching close brace.
      let depth = 1;
      let j = open + 1;
      while (j < block.length && depth > 0) {
        const ch = block[j];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        j++;
      }
      const body = block.slice(open + 1, j - 1);
      const trimmed = selector.trimStart();
      if (trimmed.startsWith("@")) {
        if (/^@(media|layer|supports|container)/.test(trimmed)) {
          const pruned = pruneBlock(body);
          if (pruned.trim() !== "") out += selector + "{" + pruned + "}";
        } else {
          out += selector + "{" + body + "}";
        }
      } else {
        const hashes = [...selector.matchAll(/\.(m_[0-9a-zA-Z]+)/g)].map(
          (m) => m[1],
        );
        if (hashes.length === 0 || hashes.some((h) => usedClasses.has(h))) {
          out += selector + "{" + body + "}";
        }
      }
      i = j;
    }
    return out;
  }
  return pruneBlock(css);
}

// Extract and gzip-compress the WASM from zstddec package.
// Returns base64-encoded gzipped WASM for smaller raw file size.
function getGzippedWasmBase64(): string {
  // Find zstddec in node_modules relative to this file or cwd.
  const paths = [
    join(
      dirname(import.meta.url.replace("file://", "")),
      "node_modules/zstddec/dist/zstddec.esm.js",
    ),
    join(process.cwd(), "node_modules/zstddec/dist/zstddec.esm.js"),
  ];

  for (const path of paths) {
    try {
      const content = readFileSync(path, "utf8");
      const match = content.match(/var wasm = '([^']+)'/);
      if (match) {
        // Decode the base64 WASM, gzip it, then re-encode as base64.
        const wasmBinary = Buffer.from(match[1], "base64");
        const gzipped = gzipSync(wasmBinary, { level: 9 });
        return gzipped.toString("base64");
      }
    } catch {
      continue;
    }
  }
  throw new Error("Could not find zstddec WASM");
}

// Minimal zstd decompression loader script.
// First decompresses gzipped WASM with native DecompressionStream, then uses
// zstddec for the payload: a single zstd frame holding the CSS (data-ss bytes)
// followed by the JS (data-cs bytes), base64-encoded in data-p.
// Waits for DOMContentLoaded to ensure the root element exists before React runs.
function makeLoaderScript(gzippedWasmBase64: string): string {
  return `
(async()=>{
  const d=document.currentScript.dataset;
  /* Native base64 decode: Uint8Array.fromBase64 where available, else the
     browser's data: URL parser -- both C++, no per-char JS loop. */
  const de=async(s)=>Uint8Array.fromBase64?Uint8Array.fromBase64(s):new Uint8Array(await (await fetch("data:application/octet-stream;base64,"+s)).arrayBuffer());
  const gzWasm=${JSON.stringify(gzippedWasmBase64)};
  let inst,heap;
  const init=async()=>{
    const s=new DecompressionStream("gzip");const w=s.writable.getWriter();w.write(await de(gzWasm));w.close();
    const wasm=await new Response(s.readable).arrayBuffer();
    const m=await WebAssembly.instantiate(wasm,{env:{emscripten_notify_memory_growth:()=>{heap=new Uint8Array(inst.exports.memory.buffer);}}});
    inst=m.instance;heap=new Uint8Array(inst.exports.memory.buffer);
    /* Publish the compiled module so the app can instantiate its own zstd
       decoders (src/zstd.ts) without bundling a second copy of the WASM.
       NOTE: this template is newline-stripped, so no line comments here. */
    globalThis.__viserZstdWasm=m.module;
  };
  await init();
  const a=await de(d.p);
  const ss=+d.ss,cs=+d.cs,sz=ss+cs;
  const cp=inst.exports.malloc(a.length);heap.set(a,cp);
  const up=inst.exports.malloc(sz);
  inst.exports.ZSTD_decompress(up,sz,cp,a.length);
  const td=new TextDecoder();
  if(ss){const e=document.createElement("style");e.textContent=td.decode(heap.subarray(up,up+ss));document.head.appendChild(e);}
  if(cs){
    const code=td.decode(heap.subarray(up+ss,up+sz));
    const run=()=>{const e=document.createElement("script");e.type="module";e.textContent=code;document.head.appendChild(e);};
    if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",run);}else{run();}
  }
  inst.exports.free(cp);inst.exports.free(up);
})();
`
    .trim()
    .replace(/\n/g, "");
}

export function compressHtml(): Plugin {
  // Cache the loader script (it embeds the gzipped WASM).
  let loaderScript: string | null = null;

  return {
    name: "compress-html",
    enforce: "post",
    generateBundle(_, bundle) {
      if (loaderScript === null) {
        const gzippedWasmBase64 = getGzippedWasmBase64();
        loaderScript = makeLoaderScript(gzippedWasmBase64);
        console.log(
          `[compress-html] Using zstd with ${(gzippedWasmBase64.length / 1024).toFixed(1)} KiB gzipped WASM decoder`,
        );
      }

      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (fileName.endsWith(".html") && chunk.type === "asset") {
          let html = chunk.source as string;
          const originalSize = Buffer.byteLength(html, "utf8");

          const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/);
          const scriptMatch = html.match(
            /<script type="module" crossorigin>([\s\S]*?)<\/script>/,
          );
          if (!styleMatch || !scriptMatch) {
            // Hard failure, not a skip: the app's zstd support depends on
            // this plugin's loader publishing the WASM module (src/zstd.ts),
            // so silently emitting an unprocessed build would produce a
            // client that connects but can never decode messages.
            throw new Error(
              "[compress-html] Could not find the inline style/script to " +
                "compress; did vite-plugin-singlefile's output format change?",
            );
          }

          let styleText = styleMatch ? styleMatch[1] : "";
          const scriptText = scriptMatch ? scriptMatch[1] : "";
          if (styleText !== "" && scriptText !== "") {
            const beforeKiB = (styleText.length / 1024).toFixed(1);
            styleText = pruneMantineCss(styleText, scriptText);
            console.log(
              `[compress-html] Pruned unused Mantine CSS: ${beforeKiB} KiB -> ${(styleText.length / 1024).toFixed(1)} KiB`,
            );
          }
          const styleBytes = Buffer.from(styleText, "utf8");
          const scriptBytes = Buffer.from(scriptText, "utf8");
          if (styleMatch) html = html.replace(styleMatch[0], "");
          if (scriptMatch) html = html.replace(scriptMatch[0], "");

          // Single zstd frame over CSS + JS so shared content deduplicates.
          const payload = Buffer.concat([styleBytes, scriptBytes]);
          const compressed = zstdCompressSync(payload, {
            params: { [constants.ZSTD_c_compressionLevel]: 22 },
          });
          const encoded = compressed.toString("base64");

          // Verify the encode/compress round trip before shipping it.
          const decoded = Buffer.from(encoded, "base64");
          if (
            !decoded.equals(compressed) ||
            !zstdDecompressSync(decoded).equals(payload)
          ) {
            throw new Error("[compress-html] Round-trip verification failed");
          }

          const loaderTag =
            `<script data-p="${encoded}"` +
            ` data-ss="${styleBytes.length}" data-cs="${scriptBytes.length}">` +
            `${loaderScript}</script>`;
          // NOTE: the replacement must be a function. A replacement *string*
          // gives `$` special meaning ("$$" collapses to "$"); base64 has no
          // `$`, but the loader script itself could, so keep it robust.
          html = html.replace("</head>", () => `${loaderTag}</head>`);
          if (!html.includes(encoded)) {
            throw new Error(
              "[compress-html] Encoded payload corrupted during insertion",
            );
          }

          const newSize = Buffer.byteLength(html, "utf8");
          console.log(
            `[compress-html] ${fileName}: ${(originalSize / 1024).toFixed(1)} KiB -> ${(newSize / 1024).toFixed(1)} KiB`,
          );

          chunk.source = html;
        }
      }
    },
  };
}
