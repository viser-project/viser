"""Generate a README.md for the ci/reference_images branch.

Usage:
    python tests/e2e/generate_readme.py <image_dir> [--commit-sha SHA]
"""

from __future__ import annotations

import argparse
import datetime
from pathlib import Path


def generate_readme(image_dir: Path, commit_sha: str | None = None) -> str:
    """Build markdown content from all .png files in *image_dir*."""
    images = sorted(image_dir.glob("*.png"))

    lines: list[str] = [
        "# Viser Visual References",
        "",
    ]
    if commit_sha:
        lines.append(f"Generated from main at `{commit_sha}`.")
        lines.append("")
    lines.append(
        f"Last updated: {datetime.datetime.now(datetime.timezone.utc):%Y-%m-%d %H:%M:%S} UTC"
    )
    lines.append("")

    if not images:
        lines.append("_No reference images found._")
    else:
        for img in images:
            lines.append(f"### {img.stem}")
            lines.append("")
            lines.append(f"![{img.stem}]({img.name})")
            lines.append("")

    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate reference images README.")
    parser.add_argument("image_dir", type=Path, help="Directory containing .png files.")
    parser.add_argument("--commit-sha", default=None, help="Commit SHA for provenance.")
    args = parser.parse_args()

    readme_content = generate_readme(args.image_dir, args.commit_sha)
    out_path = args.image_dir / "README.md"
    out_path.write_text(readme_content)
    print(f"Wrote {out_path}")


if __name__ == "__main__":
    main()
