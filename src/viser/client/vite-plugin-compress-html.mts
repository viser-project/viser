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
 * - The compressed frame is stored in a data attribute using a base-88
 *   encoding (4 bytes -> 5 chars, 25% overhead vs. base64's 33%). The
 *   alphabet is every printable ASCII character that needs no escaping in a
 *   double-quoted HTML attribute.
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

// Base-88 alphabet: printable ASCII (0x21-0x7E) minus the characters that are
// unsafe or escape-prone inside a double-quoted HTML attribute and inside the
// loader's own JS string context: " & < > ' `
const B88_ALPHABET = (() => {
  let chars = "";
  for (let c = 0x21; c <= 0x7e; c++) {
    const ch = String.fromCharCode(c);
    if ("\"&<>'`".includes(ch)) continue;
    chars += ch;
  }
  if (chars.length !== 88) {
    throw new Error(`Expected 88-char alphabet, got ${chars.length}`);
  }
  return chars;
})();

// Encode 4 bytes into 5 chars (final partial group of r bytes -> r+1 chars).
function toBase88(buffer: Buffer): string {
  const out: string[] = [];
  let i = 0;
  for (; i + 4 <= buffer.length; i += 4) {
    let v = buffer.readUInt32BE(i);
    const group = new Array<string>(5);
    for (let j = 4; j >= 0; j--) {
      group[j] = B88_ALPHABET[v % 88];
      v = Math.floor(v / 88);
    }
    out.push(group.join(""));
  }
  const r = buffer.length - i;
  if (r > 0) {
    let v = 0;
    for (let j = 0; j < r; j++) v = v * 256 + buffer[i + j];
    const group = new Array<string>(r + 1);
    for (let j = r; j >= 0; j--) {
      group[j] = B88_ALPHABET[v % 88];
      v = Math.floor(v / 88);
    }
    out.push(group.join(""));
  }
  return out.join("");
}

// Reference decoder, used to verify the round trip at build time. The loader
// script embeds an equivalent (minified) implementation.
function fromBase88(text: string): Buffer {
  const lut = new Map<string, number>();
  for (let i = 0; i < 88; i++) lut.set(B88_ALPHABET[i], i);
  const nGroups = Math.floor(text.length / 5);
  const r = text.length % 5; // Final group of k chars encodes k-1 bytes.
  const outLen = nGroups * 4 + (r > 0 ? r - 1 : 0);
  const out = Buffer.alloc(outLen);
  let oi = 0;
  let i = 0;
  for (; i + 5 <= text.length; i += 5) {
    let v = 0;
    for (let j = 0; j < 5; j++) v = v * 88 + lut.get(text[i + j])!;
    out.writeUInt32BE(v >>> 0, oi);
    oi += 4;
  }
  if (r > 0) {
    let v = 0;
    for (let j = 0; j < r; j++) v = v * 88 + lut.get(text[i + j])!;
    for (let j = r - 2; j >= 0; j--) {
      out[oi + j] = v % 256;
      v = Math.floor(v / 256);
    }
  }
  return out;
}

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
// Returns base88-encoded gzipped WASM for smaller raw file size.
function getGzippedWasmBase88(): string {
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
        // Decode the base64 WASM, gzip it, then re-encode as base88.
        const wasmBinary = Buffer.from(match[1], "base64");
        const gzipped = gzipSync(wasmBinary, { level: 9 });
        return toBase88(gzipped);
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
// followed by the JS (data-cs bytes), base88-encoded in data-p.
// Waits for DOMContentLoaded to ensure the root element exists before React runs.
function makeLoaderScript(gzippedWasmBase88: string): string {
  return `
(async()=>{
  const d=document.currentScript.dataset;
  const A=${JSON.stringify(B88_ALPHABET)};
  const L=new Int8Array(127);for(let i=0;i<88;i++)L[A.charCodeAt(i)]=i;
  const de=(s)=>{
    const n=Math.floor(s.length/5),r=s.length%5,a=new Uint8Array(n*4+(r?r-1:0));
    let i=0,o=0;
    for(;i+5<=s.length;i+=5){
      let v=0;for(let j=0;j<5;j++)v=v*88+L[s.charCodeAt(i+j)];
      a[o++]=v/16777216&255;a[o++]=v/65536&255;a[o++]=v/256&255;a[o++]=v&255;
    }
    if(r){
      let v=0;for(let j=0;j<r;j++)v=v*88+L[s.charCodeAt(i+j)];
      for(let j=r-2;j>=0;j--){a[o+j]=v%256;v=Math.floor(v/256);}
    }
    return a;
  };
  const gzWasm=${JSON.stringify(gzippedWasmBase88)};
  let inst,heap;
  const init=async()=>{
    const s=new DecompressionStream("gzip");const w=s.writable.getWriter();w.write(de(gzWasm));w.close();
    const wasm=await new Response(s.readable).arrayBuffer();
    const m=await WebAssembly.instantiate(wasm,{env:{emscripten_notify_memory_growth:()=>{heap=new Uint8Array(inst.exports.memory.buffer);}}});
    inst=m.instance;heap=new Uint8Array(inst.exports.memory.buffer);
    /* Publish the compiled module so the app can instantiate its own zstd
       decoders (src/zstd.ts) without bundling a second copy of the WASM.
       NOTE: this template is newline-stripped, so no line comments here. */
    globalThis.__viserZstdWasm=m.module;
  };
  await init();
  const a=de(d.p);
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
        const gzippedWasmBase88 = getGzippedWasmBase88();
        loaderScript = makeLoaderScript(gzippedWasmBase88);
        console.log(
          `[compress-html] Using zstd with ${(gzippedWasmBase88.length / 1024).toFixed(1)} KiB gzipped WASM decoder`,
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
          const encoded = toBase88(compressed);

          // Verify the encode/compress round trip before shipping it.
          const decoded = fromBase88(encoded);
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
          // gives `$` special meaning ("$$" collapses to "$"), and `$` is
          // part of the base88 alphabet, which silently corrupts the payload.
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
