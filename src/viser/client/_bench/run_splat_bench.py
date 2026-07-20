"""Run the end-to-end Gaussian-splat render benchmark.

Spawns the Vite dev server (so the real TypeScript shader + WASM sorter are
served as-is), drives it with a headed Chromium using ANGLE/Metal for a real
GPU, and prints the per-frame sort/draw timings as JSON.

Usage:
    python _bench/run_splat_bench.py
"""

import json
import os
import socket
import subprocess
import sys
import time
from contextlib import closing

from playwright.sync_api import sync_playwright

CLIENT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def free_port() -> int:
    with closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def wait_for_server(url: str, timeout: float = 60.0) -> None:
    import urllib.request

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            urllib.request.urlopen(url, timeout=1)
            return
        except Exception:
            time.sleep(0.3)
    raise RuntimeError(f"vite did not come up at {url}")


def main() -> None:
    port = free_port()
    vite = subprocess.Popen(
        ["npx", "vite", "--port", str(port), "--strictPort"],
        cwd=CLIENT_DIR,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    url = f"http://localhost:{port}/_bench/splat_bench.html"
    try:
        wait_for_server(f"http://localhost:{port}/")
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=False,  # headed -> real GPU on macOS
                args=[
                    "--use-angle=metal",
                    "--ignore-gpu-blocklist",
                    "--enable-gpu",
                    "--disable-gpu-sandbox",
                ],
            )
            page = browser.new_page(viewport={"width": 1920, "height": 1080})
            page.on("console", lambda m: print("[page]", m.text, file=sys.stderr))
            page.on("pageerror", lambda e: print("[pageerror]", e, file=sys.stderr))
            page.goto(url)
            page.wait_for_function("window.__ready === true", timeout=60000)
            results = page.evaluate("() => window.benchSplats()")
            print("RESULTS_JSON_START")
            print(json.dumps(results, indent=2))
            print("RESULTS_JSON_END")
            browser.close()
    finally:
        vite.terminate()
        try:
            vite.wait(timeout=10)
        except Exception:
            vite.kill()


if __name__ == "__main__":
    main()
