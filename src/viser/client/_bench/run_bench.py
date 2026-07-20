import json

from playwright.sync_api import sync_playwright

html = "http://localhost:8899/_bench/bench.html"

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
    page = browser.new_page()
    page.on("console", lambda m: print("[page]", m.text))
    page.on("pageerror", lambda e: print("[pageerror]", e))
    page.goto(html)
    page.wait_for_function("window.__ready === true", timeout=15000)
    results = page.evaluate("() => window.bench()")
    print("RESULTS_JSON_START")
    print(json.dumps(results, indent=2))
    print("RESULTS_JSON_END")
    browser.close()
