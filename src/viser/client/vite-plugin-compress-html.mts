/**
 * Simple Vite plugin to compress the inlined HTML output.
 * Uses zstd compression with embedded WASM decoder for decompression at runtime.
 *
 * This is a simplified alternative to vite-plugin-singlefile-compression
 * that doesn't add problematic import.meta.url polyfills.
 */

import { Plugin } from "vite";
import { gzipSync, zstdCompressSync, constants } from "zlib";
import { readFileSync } from "fs";
import { dirname, join } from "path";

// Base64 encoding that's safe for embedding in HTML.
function toBase64(buffer: Buffer): string {
  return buffer.toString("base64");
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
// First decompresses gzipped WASM with native DecompressionStream, then uses zstddec for content.
// Waits for DOMContentLoaded to ensure the root element exists before React runs.
function makeLoaderScript(gzippedWasmBase64: string): string {
  return `
(async()=>{
  const d=document.currentScript.dataset;
  const gzWasm="${gzippedWasmBase64}";
  let inst,heap;
  const init=async()=>{
    const b=atob(gzWasm);const a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);
    const s=new DecompressionStream("gzip");const w=s.writable.getWriter();w.write(a);w.close();
    const wasm=await new Response(s.readable).arrayBuffer();
    const m=await WebAssembly.instantiate(wasm,{env:{emscripten_notify_memory_growth:()=>{heap=new Uint8Array(inst.exports.memory.buffer);}}});
    inst=m.instance;heap=new Uint8Array(inst.exports.memory.buffer);
  };
  const dec=(b64,sz)=>{
    const b=atob(b64);const a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);
    const cp=inst.exports.malloc(a.length);heap.set(a,cp);
    const up=inst.exports.malloc(sz);
    inst.exports.ZSTD_decompress(up,sz,cp,a.length);
    const out=heap.slice(up,up+sz);
    inst.exports.free(cp);inst.exports.free(up);
    return new TextDecoder().decode(out);
  };
  await init();
  if(d.s){const e=document.createElement("style");e.textContent=dec(d.s,+d.ss);document.head.appendChild(e);}
  if(d.c){
    const code=dec(d.c,+d.cs);
    const run=()=>{const e=document.createElement("script");e.type="module";e.textContent=code;document.head.appendChild(e);};
    if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",run);}else{run();}
  }
})();
`
    .trim()
    .replace(/\n/g, "");
}

export function compressHtml(): Plugin {
  // Cache the WASM base64 and loader script.
  let loaderScript: string | null = null;

  return {
    name: "compress-html",
    enforce: "post",
    generateBundle(_, bundle) {
      // Lazily initialize the loader script with gzip-compressed WASM.
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

          // Find and compress the inline style with zstd level 22.
          const styleMatch = html.match(/<style[^>]*>([\s\S]*?)<\/style>/);
          let styleAttr = "";
          if (styleMatch) {
            const styleBytes = Buffer.from(styleMatch[1], "utf8");
            const compressed = zstdCompressSync(styleBytes, {
              params: { [constants.ZSTD_c_compressionLevel]: 22 },
            });
            // data-s: compressed data, data-ss: original size (for zstd decompression).
            styleAttr = ` data-s="${toBase64(compressed)}" data-ss="${styleBytes.length}"`;
            html = html.replace(styleMatch[0], "");
          }

          // Find and compress the inline script module with zstd level 22.
          const scriptMatch = html.match(
            /<script type="module" crossorigin>([\s\S]*?)<\/script>/,
          );
          let scriptAttr = "";
          if (scriptMatch) {
            const scriptBytes = Buffer.from(scriptMatch[1], "utf8");
            const compressed = zstdCompressSync(scriptBytes, {
              params: { [constants.ZSTD_c_compressionLevel]: 22 },
            });
            // data-c: compressed data, data-cs: original size (for zstd decompression).
            scriptAttr = ` data-c="${toBase64(compressed)}" data-cs="${scriptBytes.length}"`;
            html = html.replace(scriptMatch[0], "");
          }

          if (!styleMatch && !scriptMatch) {
            console.log(
              "[compress-html] No inline style or script found, skipping compression",
            );
            continue;
          }

          // Insert our loader script before </head>.
          const loaderTag = `<script${styleAttr}${scriptAttr}>${loaderScript}</script>`;
          html = html.replace("</head>", `${loaderTag}</head>`);

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
