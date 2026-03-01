"""Standalone script to generate reference screenshots for visual regression tests.

Usage:
    python -m tests.e2e.generate_references [--output-dir DIR]

The default output directory is ``.reference_images/`` at the repo root.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

import viser
import viser._client_autobuild
from .scenes import SCENES
from .utils import (
    VIEWPORT_HEIGHT,
    VIEWPORT_WIDTH,
    find_free_port,
    wait_for_connection,
)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Generate reference screenshots for viser visual regression tests."
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parent.parent.parent / ".reference_images",
        help="Directory to save reference screenshots.",
    )
    args = parser.parse_args()
    output_dir: Path = args.output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    # Skip the client autobuild check.
    viser._client_autobuild.ensure_client_is_built = lambda: None

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)

        for name, builder in SCENES:
            print(f"Generating: {name}")
            port = find_free_port()
            server = viser.ViserServer(port=port, verbose=False)
            time.sleep(0.3)

            builder(server)

            page = browser.new_page()
            wait_for_connection(page, port)

            # Wait for rendering to settle.
            page.wait_for_timeout(3000)

            page.set_viewport_size({"width": VIEWPORT_WIDTH, "height": VIEWPORT_HEIGHT})
            page.wait_for_timeout(500)
            path = output_dir / f"{name}.png"
            page.screenshot(path=str(path))
            print(f"  Saved {path}")

            page.close()
            server.stop()

        browser.close()

    print(f"\nAll {len(SCENES)} reference screenshots saved to {output_dir}")


if __name__ == "__main__":
    main()
