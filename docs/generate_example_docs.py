#!/usr/bin/env python3
"""
Automatically run viser examples and capture screenshots for documentation.

This script:
1. Runs each example in a subprocess
2. Opens a browser to connect to the viser server
3. Captures a screenshot
4. Saves it to docs/source/_static/examples/
"""

from __future__ import annotations

import asyncio
import os
import random
import subprocess
import sys
from pathlib import Path
from typing import List, Tuple

import tyro


async def capture_screenshot_playwright(
    url: str, output_path: Path, wait_time: float = 10.0
) -> bool:
    """Capture screenshot using Playwright. Generates both full-size and thumbnail versions."""
    try:
        from playwright.async_api import async_playwright

    except ImportError:
        raise SystemExit(
            "Warning: playwright not installed. Install with: pip install playwright && playwright install chromium"
        )
    async with async_playwright() as p:
        browser = await p.chromium.launch(args=["--use-gl=angle"])
        # Set viewport to 16:9 aspect ratio with higher resolution for better quality
        # Using 2x resolution for retina-quality screenshots
        page = await browser.new_page(
            viewport={"width": 1280, "height": 720},
            device_scale_factor=2,  # This gives us 2x DPI
        )

        try:
            # Navigate to the page
            await page.goto(url)

            # Wait for the scene to load
            await asyncio.sleep(wait_time)

            await page.screenshot(path=str(output_path), type="png")

            thumb_path = output_path.parent / "thumbs" / output_path.name
            thumb_path.parent.mkdir(exist_ok=True)

            await page.set_viewport_size({"width": 960, "height": 540})
            await page.screenshot(path=str(thumb_path), type="png")

            print(f"  ✓ Screenshots saved: {output_path.name} (full + thumbnail)")
            return True

        except Exception as e:
            print(f"  ✗ Failed to capture screenshot: {e}")
            return False
        finally:
            await browser.close()


def extract_title_and_description(file_path: Path) -> Tuple[str, str, str]:
    """Extract title (first line), description, and full docstring from module docstring."""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Parse the Python file to extract docstring
        import ast

        tree = ast.parse(content)

        # Get module docstring
        docstring = ast.get_docstring(tree)
        if docstring:
            lines = docstring.strip().split("\n")
            if lines:
                # First line is the title
                title = lines[0].strip()

                # Rest is description - combine lines until we get a complete sentence
                description = ""
                desc_lines = []
                for line in lines[1:]:
                    line = line.strip()
                    if line:
                        desc_lines.append(line)
                        # Join accumulated lines and check if we have a complete sentence
                        full_desc = " ".join(desc_lines)
                        # Handle abbreviations before splitting
                        temp_desc = (
                            full_desc.replace("e.g.,", "EG_COMMA")
                            .replace("i.e.,", "IE_COMMA")
                            .replace("etc.,", "ETC_COMMA")
                        )
                        sentences = temp_desc.split(".")
                        if (
                            sentences and len(sentences) > 1
                        ):  # We have at least one complete sentence
                            # Restore abbreviations and get first sentence
                            description = (
                                sentences[0]
                                .replace("EG_COMMA", "e.g.,")
                                .replace("IE_COMMA", "i.e.,")
                                .replace("ETC_COMMA", "etc.,")
                                .strip()
                                + "."
                            )
                            break
                    elif (
                        desc_lines
                    ):  # Empty line after we've started collecting description
                        # Use what we have so far
                        description = " ".join(desc_lines)
                        break

                # If we didn't find a complete sentence, use what we collected
                if not description and desc_lines:
                    description = " ".join(desc_lines)

                # Avoid duplicate if description is same as title
                if description.strip().rstrip(".") == title.strip().rstrip("."):
                    description = ""

                # Return full docstring for RST generation
                full_docstring = docstring.strip()
                return title, description, full_docstring

        # Fallback to filename-based
        title = file_path.stem.replace("_", " ").title()
        return title, "", ""
    except Exception:
        title = file_path.stem.replace("_", " ").title()
        return title, "", ""


def find_examples() -> List[Tuple[str, Path, str, str, str]]:
    """Find all Python examples in the examples directory with titles, descriptions, and docstrings."""
    examples = []
    examples_dir = Path(__file__).parent.parent / "examples"

    # Add examples from each category
    categories = [
        "00_getting_started",
        "01_scene",
        "02_gui",
        "03_interaction",
        "04_demos",
    ]
    for category in categories:
        category_dir = examples_dir / category
        if category_dir.exists():
            for example_file in sorted(category_dir.glob("*.py")):
                if not example_file.name.startswith("_"):  # Skip private files
                    example_name = f"{category}/{example_file.stem}"
                    title, desc, full_doc = extract_title_and_description(example_file)
                    examples.append((example_name, example_file, title, desc, full_doc))

    return examples


async def run_example_and_capture(
    example_name: str, example_path: Path, output_dir: Path, port: int
) -> Tuple[str, bool]:
    """Run a single example and capture its screenshot."""
    print(f"Processing {example_name} on port {port}...")

    # Create output filename
    safe_name = example_name.replace("/", "_")
    output_path = output_dir / f"{safe_name}.png"

    # Start the example process with specific port using environment variable
    env = os.environ.copy()
    env["_VISER_PORT_OVERRIDE"] = str(port)

    # Build command with special arguments for certain examples
    cmd = [sys.executable, str(example_path)]
    process = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        env=env,
    )

    try:
        # Wait a bit for the server to start
        await asyncio.sleep(5.0)

        # Check if process is still running
        if process.poll() is not None:
            print(f"  ✗ {example_name} exited early with code {process.returncode}")
            stdout, stderr = process.communicate()
            if stderr:
                print(f"  Error: {stderr}")
            return example_name, False

        # Capture screenshot
        url = f"http://localhost:{port}/?dummyWindowDimensions=fill&hideViserLogo=&dummyWindowTitle=localhost:8080"
        success = await capture_screenshot_playwright(url, output_path)

        if success:
            print(f"  ✓ {example_name} completed")
        return example_name, success

    finally:
        # Clean up the process
        process.terminate()
        try:
            process.wait(timeout=5.0)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


async def process_batch(
    batch: List[Tuple[str, Path, str, str, str]], output_dir: Path
) -> List[Tuple[str, bool]]:
    """Process a batch of examples in parallel with random ports."""
    tasks = []
    used_ports = set()

    for example_name, example_path, _title, _desc, _full_doc in batch:
        # Generate a random port between 8080 and 9999
        while True:
            port = random.randint(8080, 9999)
            if port not in used_ports:
                used_ports.add(port)
                break

        task = run_example_and_capture(example_name, example_path, output_dir, port)
        tasks.append(task)

    return await asyncio.gather(*tasks)


async def capture_all_screenshots(name_filter: str | None, batch_size: int = 8):
    """Main function to capture screenshots for filtered examples."""
    # Create output directory
    output_dir = Path(__file__).parent / "source" / "_static" / "examples"
    output_dir.mkdir(parents=True, exist_ok=True)

    # Find all examples
    all_examples = find_examples()

    # Filter examples based on name_filter
    if name_filter is not None:
        examples = [ex for ex in all_examples if name_filter.lower() in ex[0].lower()]
    else:
        examples = []

    print(f"Found {len(all_examples)} total examples")
    print(f"Processing {len(examples)} examples matching '{name_filter}'")
    print(f"Processing in batches of {batch_size}")

    # Process examples in batches
    successful = 0
    failed = []

    for i in range(0, len(examples), batch_size):
        batch = examples[i : i + batch_size]
        print(
            f"\nBatch {i // batch_size + 1}/{(len(examples) + batch_size - 1) // batch_size}"
        )

        # Process batch in parallel
        results = await process_batch(batch, output_dir)

        # Count successes and failures
        for example_name, success in results:
            if success:
                successful += 1
            else:
                failed.append(example_name)

        # Small delay between batches
        if i + batch_size < len(examples):
            await asyncio.sleep(2.0)

    # Summary
    print("\n" + "=" * 50)
    print("Screenshot capture complete!")
    print(f"  ✓ Successful: {successful}")
    print(f"  ✗ Failed: {len(failed)}")
    if failed:
        print(f"  Failed examples: {', '.join(failed)}")

    # Generate RST include file and organized files for ALL examples
    # (RST generation is cheap, so we always do it for all examples)
    generate_screenshot_includes(all_examples, output_dir)

    # Generate organized RST files and update index
    generate_organized_rst_files(all_examples)
    update_index_rst(all_examples)


def generate_screenshot_includes(
    examples: List[Tuple[str, Path, str, str, str]], output_dir: Path
):
    """Generate RST include file for screenshots with a nice gallery."""
    include_file = output_dir.parent.parent / "examples" / "_example_gallery.rst"

    # Category metadata
    categories = {
        "00_getting_started": ("Getting Started", 0),
        "01_scene": ("Scene Visualization", 1),
        "02_gui": ("GUI Controls", 2),
        "03_interaction": ("User Interaction", 3),
        "04_demos": ("Demos", 4),
    }

    # Group examples by category
    grouped = {}
    for example_name, example_path, title, desc, full_doc in examples:
        if "/" in example_name:
            category = example_name.split("/")[0]
        else:
            category = example_name

        if category not in grouped:
            grouped[category] = []
        grouped[category].append((example_name, example_path, title, desc, full_doc))

    with open(include_file, "w") as f:
        f.write(".. This file is auto-generated by capture_example_screenshots.py\n")
        f.write(
            ".. Include this in your documentation with: .. include:: _example_gallery.rst\n\n"
        )

        # Sort categories by their order
        sorted_categories = sorted(
            grouped.keys(), key=lambda x: categories.get(x, (x, 999))[1]
        )

        # Write gallery content
        for category in sorted_categories:
            category_name, _ = categories.get(
                category, (category.replace("_", " ").title(), 999)
            )

            f.write(f"\n{category_name}\n")
            f.write("~" * len(category_name.encode("utf-8")) + "\n\n")

            # Create a grid table for examples
            f.write(".. raw:: html\n\n")
            f.write("   <style>\n")
            f.write(
                "   .example-card:hover { transform: translateY(-4px); box-shadow: 0 4px 12px rgba(0,0,0,0.1); }\n"
            )
            f.write("   </style>\n")
            f.write(
                '   <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; margin: 20px 0;">\n'
            )

            for example_name, example_path, title, desc, full_doc in grouped[category]:
                safe_name = example_name.replace("/", "_")
                # Use thumbnail for gallery grid
                image_path = f"_static/examples/thumbs/{safe_name}.png"

                # Map to organized directory structure with clean URLs
                category_mapping = {
                    "00_getting_started": "examples/getting_started",
                    "01_scene": "examples/scene",
                    "02_gui": "examples/gui",
                    "03_interaction": "examples/interaction",
                    "04_demos": "examples/demos",
                }
                category_dir = category_mapping.get(
                    category, "examples/getting_started"
                )
                # Generate clean URL name by removing numbered prefixes
                clean_name = example_name.split("/")[-1].partition("_")[2]
                code_page_url = f"{category_dir}/{clean_name}/"

                # Clean text for HTML: remove line breaks and escape quotes
                title_clean = (
                    title.replace("\n", " ")
                    .replace("\r", " ")
                    .replace('"', "&quot;")
                    .strip()
                )
                desc_clean = (
                    desc.replace("\n", " ")
                    .replace("\r", " ")
                    .replace('"', "&quot;")
                    .strip()
                )

                f.write(
                    '       <div class="example-card" style="border-radius: 3px; overflow: hidden; background: white; transition: transform 0.2s;">\n'
                )
                f.write(
                    f'           <a href="{code_page_url}" style="text-decoration: none; color: inherit; display: block;">\n'
                )
                f.write(
                    f'               <img src="{image_path}" alt="{title_clean}" style="width: 100%; height: auto; aspect-ratio: 16/9; object-fit: cover; display: block;">\n'
                )
                f.write('               <div style="padding: 15px;">\n')
                f.write(
                    f'                   <h4 style="margin: 0; padding: 0; font-size: 16px; font-weight: 600; color: #333; margin-bottom: 8px;">{title_clean}</h4>\n'
                )
                if desc_clean:
                    f.write(
                        f'                   <p style="margin: 0; padding: 0; color: #666; font-size: 13px; line-height: 1.4;">{desc_clean}</p>\n'
                    )
                f.write("               </div>\n")
                f.write("           </a>\n")
                f.write("       </div>\n")

            f.write("   </div>\n")

    print(f"\nGenerated example gallery at {include_file}")


def cleanup_old_files(
    source_dir: Path,
    categories: dict,
    examples: list[tuple[str, Path, str, str, str]] | None = None,
):
    """Remove old RST files and screenshots that are no longer needed."""
    # Clean up example category directories
    for category_dir in set(categories.values()):
        category_path = source_dir / category_dir
        if category_path.exists():
            # Remove all .rst files except index.rst
            for rst_file in category_path.glob("*.rst"):
                if rst_file.name != "index.rst":
                    rst_file.unlink()

    # Clean up generated directory
    generated_dir = source_dir / "examples" / "generated"
    if generated_dir.exists():
        for rst_file in generated_dir.glob("*.rst"):
            if rst_file.name != "index.rst":
                rst_file.unlink()

    # Clean up old screenshots that no longer correspond to examples
    if examples is not None:
        screenshots_dir = source_dir / "_static" / "examples"
        if screenshots_dir.exists():
            # Get expected screenshot names
            expected_screenshots = set()
            for example_name, _, _, _, _ in examples:
                safe_name = example_name.replace("/", "_")
                expected_screenshots.add(f"{safe_name}.png")

            # Remove unexpected screenshots
            for screenshot in screenshots_dir.glob("*.png"):
                if screenshot.name not in expected_screenshots:
                    screenshot.unlink()
                    print(f"Removed old screenshot: {screenshot.name}")

            # Clean up thumbnails directory
            thumbs_dir = screenshots_dir / "thumbs"
            if thumbs_dir.exists():
                for thumb in thumbs_dir.glob("*.png"):
                    if thumb.name not in expected_screenshots:
                        thumb.unlink()
                        print(f"Removed old thumbnail: {thumb.name}")

    print("Cleaned up old documentation files")


def generate_organized_rst_files(examples: List[Tuple[str, Path, str, str, str]]):
    """Generate RST files in organized directory structure."""
    source_dir = Path(__file__).parent / "source"

    # Create category directories
    categories = {
        "00_getting_started": "examples/getting_started",
        "01_scene": "examples/scene",
        "02_gui": "examples/gui",
        "03_interaction": "examples/interaction",
        "04_demos": "examples/demos",
    }

    # Clean up old files before generating new ones
    cleanup_old_files(source_dir, categories, examples)

    # Create directories
    for category_dir in set(categories.values()):
        (source_dir / category_dir).mkdir(exist_ok=True)

    # Generate RST files in appropriate directories
    for example_name, example_path, title, desc, full_docstring in examples:
        # Determine category
        if "/" in example_name:
            category_key = example_name.split("/")[0]
        else:
            category_key = example_name

        category_dir = categories[category_key]
        safe_name = example_name.replace("/", "_")

        # Generate clean filename by removing numbered prefixes
        clean_name = example_name.split("/")[-1].partition("_")[2]

        # Create RST file path with clean name
        rst_path = source_dir / category_dir / f"{clean_name}.rst"

        # Read the source code
        with open(example_path, "r", encoding="utf-8") as f:
            source_code = f.read()

        # Strip docstring from source code for display
        source_lines = source_code.split("\n")
        stripped_code_lines = []
        in_docstring = False
        docstring_quotes = None

        for line in source_lines:
            stripped_line = line.strip()

            # Check if we're starting a docstring
            if not in_docstring and (
                stripped_line.startswith('"""') or stripped_line.startswith("'''")
            ):
                docstring_quotes = stripped_line[:3]
                in_docstring = True
                # Check if docstring ends on same line
                if (
                    stripped_line.count(docstring_quotes) >= 2
                    and len(stripped_line) > 3
                ):
                    in_docstring = False
                continue

            # Check if we're ending a docstring
            if in_docstring and docstring_quotes in line:
                in_docstring = False
                continue

            # Skip lines that are part of docstring
            if in_docstring:
                continue

            stripped_code_lines.append(line)

        # Remove empty lines at the beginning
        while stripped_code_lines and not stripped_code_lines[0].strip():
            stripped_code_lines.pop(0)

        stripped_source_code = "\n".join(stripped_code_lines)

        # Write RST file
        with open(rst_path, "w") as f:
            f.write(f"{title}\n")
            f.write("=" * len(title) + "\n\n")

            # Add full docstring explanation (skip title and description)
            if full_docstring:
                lines = full_docstring.split("\n")
                if len(lines) > 1:
                    # Skip the first line (title) and second line if empty
                    explanation_lines = lines[1:]
                    if explanation_lines and not explanation_lines[0].strip():
                        explanation_lines = explanation_lines[1:]

                    if explanation_lines:
                        explanation = "\n".join(explanation_lines).strip()
                        # Only write explanation if it's not just the same as desc
                        if explanation and explanation != desc.strip():
                            f.write(f"{explanation}\n\n")
            elif desc:
                # Fallback to description if no full docstring
                f.write(f"{desc}\n\n")

            f.write(f"**Source:** ``examples/{example_name}.py``\n\n")

            # Add screenshot
            screenshot_path = f"../../_static/examples/{safe_name}.png"
            f.write(".. figure:: " + screenshot_path + "\n")
            f.write("   :width: 100%\n")
            f.write("   :alt: " + title + "\n\n")

            f.write("Code\n")
            f.write("----\n\n")
            f.write(".. code-block:: python\n")
            f.write("   :linenos:\n\n")

            # Indent the stripped code
            for line in stripped_source_code.split("\n"):
                f.write(f"   {line}\n")

    print(f"Generated {len(examples)} RST files in organized directories")

    # Generate index.rst files for each subdirectory
    generate_subdirectory_indexes(examples)


def generate_subdirectory_indexes(examples: List[Tuple[str, Path, str, str, str]]):
    """Generate index.rst files for each subdirectory."""
    source_dir = Path(__file__).parent / "source"

    # Group examples by category for subdirectory indexes
    example_categories = {
        "examples/getting_started": {
            "title": "Getting Started",
            "description": "Basic examples for getting started with Viser.",
            "files": [],
        },
        "examples/scene": {
            "title": "Scene Visualization",
            "description": "Examples showing 3D scene visualization in Viser.",
            "files": [],
        },
        "examples/gui": {
            "title": "GUI Controls",
            "description": "Examples demonstrating interactive GUI elements.",
            "files": [],
        },
        "examples/interaction": {
            "title": "User Interaction",
            "description": "Examples showing user input and interaction handling.",
            "files": [],
        },
        "examples/demos": {
            "title": "Demos",
            "description": "More complete demo applications.",
            "files": [],
        },
    }

    # Categorize examples
    for example_name, example_path, title, desc, full_docstring in examples:
        # Determine category
        if "/" in example_name:
            category_key = example_name.split("/")[0]
        else:
            category_key = example_name

        # Map to directory name
        category_mapping = {
            "00_getting_started": "examples/getting_started",
            "01_scene": "examples/scene",
            "02_gui": "examples/gui",
            "03_interaction": "examples/interaction",
            "04_demos": "examples/demos",
        }
        category_dir = category_mapping.get(category_key, "examples/getting_started")

        # Generate clean filename by removing numbered prefixes
        clean_name = example_name.split("/")[-1].partition("_")[2]

        if category_dir in example_categories:
            example_categories[category_dir]["files"].append(clean_name)

    # Generate example directory indexes
    for dir_name, info in example_categories.items():
        if info["files"]:  # Only create if there are files
            index_path = source_dir / dir_name / "index.rst"
            with open(index_path, "w") as f:
                f.write(f"{info['title']}\n")
                f.write("=" * len(info["title"]) + "\n\n")
                f.write(f"{info['description']}\n\n")
                f.write(".. toctree::\n")
                f.write("   :maxdepth: 1\n\n")

                for file_name in info["files"]:
                    f.write(f"   {file_name}\n")

    print("Generated index.rst files for all subdirectories")


def update_index_rst(examples: List[Tuple[str, Path, str, str, str]]):
    """Update index.rst to maintain clean toctree structure."""
    # The index.rst is now manually maintained with a clean structure.
    # This function just confirms the structure is correct.
    index_path = Path(__file__).parent / "source" / "index.rst"

    # Read current index.rst to verify it has the clean structure
    with open(index_path, "r") as f:
        content = f.read()

    # Check if it already has the simplified structure
    if (
        ".. toctree::\n   :caption: API" in content
        and ".. toctree::\n   :caption: Examples" in content
    ):
        print("Index.rst already has clean toctree structure")
        return

    print("Index.rst structure verified")


def main(
    screenshot_if_name_contains: str | None = None,
    batch_size: int = 8,
) -> None:
    """Generate example documentation and capture screenshots for filtered examples.

    Args:
        screenshot_if_name_contains: Only capture screenshots for examples whose name contains this string (case-insensitive). Use empty string to match all examples.
        batch_size: Number of examples to process in parallel batches.
    """
    # Run the main function with screenshot capture
    asyncio.run(capture_all_screenshots(screenshot_if_name_contains, batch_size))


if __name__ == "__main__":
    # Check Python version
    if sys.version_info < (3, 7):
        print("Error: This script requires Python 3.7 or later")
        sys.exit(1)

    tyro.cli(main)
