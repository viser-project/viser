import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, "bench.html");

const browser = await chromium.launch({
  headless: false, // headed -> real GPU (ANGLE/Metal) on macOS
  args: ["--ignore-gpu-blocklist", "--enable-gpu-rasterization"],
});
const page = await browser.newPage();
page.on("console", (m) => console.error("[page]", m.text()));
page.on("pageerror", (e) => console.error("[pageerror]", e.message));

await page.goto("file://" + htmlPath);
await page.waitForFunction("window.__ready === true", { timeout: 15000 });
const results = await page.evaluate(() => window.bench());
console.log(JSON.stringify(results, null, 2));
await browser.close();
