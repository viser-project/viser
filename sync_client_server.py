"""Synchronize TypeScript definitions with Python.

This script:
1. Generates TypeScript message interfaces from Python dataclasses
2. Creates a version info file to keep client and server versions in sync
3. Fetches GitHub contributors and creates a contributors info file
"""

import json
import pathlib
import subprocess
import urllib.request

import tyro

import viser
import viser.infra
from viser._messages import Message


def main(sync_messages: bool = False, sync_version: bool = False) -> None:
    messages_path = pathlib.Path(__file__).parent / pathlib.Path(
        "src/viser/client/src/WebsocketMessages.ts"
    )
    version_path = pathlib.Path(__file__).parent / pathlib.Path(
        "src/viser/client/src/VersionInfo.ts"
    )

    if sync_messages:
        # Generate TypeScript message interfaces
        defs = viser.infra.generate_typescript_interfaces(Message)

        # Create directory if it doesn't exist
        messages_path.parent.mkdir(parents=True, exist_ok=True)

        # Write to file even if it doesn't exist yet
        messages_path.write_text(defs)
        print(f"{messages_path} updated")

    if sync_version:
        # Create directory if it doesn't exist
        version_path.parent.mkdir(parents=True, exist_ok=True)

        # Try to fetch contributors from GitHub API
        contributors_data = []
        try:
            # GitHub API endpoint for contributors
            api_url = "https://api.github.com/repos/viser-project/viser/contributors?per_page=500"
            req = urllib.request.Request(
                api_url,
                headers={
                    "User-Agent": "viser-sync-script",
                    "Accept": "application/vnd.github.v3+json",
                },
            )
            with urllib.request.urlopen(req) as response:
                contributors_json = json.loads(response.read().decode())

                # Extract relevant contributor information
                for contributor in contributors_json:
                    if (
                        isinstance(contributor, dict)
                        and contributor.get("type") == "User"
                    ):
                        contributors_data.append(
                            {
                                "login": contributor.get("login", ""),
                                "html_url": contributor.get("html_url", ""),
                            }
                        )

                print(f"Fetched {len(contributors_data)} contributors from GitHub")
        except Exception as e:
            print(f"Warning: Failed to fetch contributors from GitHub: {e}")
            print("Skipping version and contributors info.")

        if len(contributors_data) > 0:
            # Generate combined version and contributors file
            version_content = f"""// Automatically generated file - do not edit manually.
        // This is synchronized with the Python package version in viser/__init__.py.
        export const VISER_VERSION = "{viser.__version__}";

        // GitHub contributors for the viser project.
        export interface Contributor {{
          login: string;
          html_url: string;
        }}

        export const GITHUB_CONTRIBUTORS: Contributor[] = {json.dumps(contributors_data, indent=2)};
        """
            version_path.write_text(version_content)
            print(f"Version and contributors info generated: {version_path}")

    # Run prettier on all generated files if it's available
    try:
        subprocess.run(
            args=["npx", "prettier", "-w", str(messages_path), str(version_path)],
            check=False,
        )
    except FileNotFoundError:
        print("Warning: npx/prettier not found, skipping formatting")

    print("Synchronization complete")


if __name__ == "__main__":
    tyro.cli(main)
