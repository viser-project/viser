"""Test that the client and server versions match and subprotocols work."""

import re
from pathlib import Path

import pytest


def test_versions_match():
    """Verify that the server version in __init__.py matches the client version in VersionInfo.ts."""
    # Get project root directory
    repo_root = Path(__file__).parent.parent

    # Read Python version from __init__.py
    init_path = repo_root / "src" / "viser" / "__init__.py"
    assert init_path.exists(), "Could not find __init__.py"

    with open(init_path, "r") as f:
        init_content = f.read()

    # Extract the version using regex
    py_version_match = re.search(r'__version__\s*=\s*["\']([^"\']+)["\']', init_content)
    assert py_version_match, "Could not find __version__ in __init__.py"
    py_version = py_version_match.group(1)

    # Read TypeScript version from VersionInfo.ts
    version_info_path = (
        repo_root / "src" / "viser" / "client" / "src" / "VersionInfo.ts"
    )

    # Skip test if file doesn't exist (might be running in a context where it hasn't been generated)
    if not version_info_path.exists():
        pytest.skip(f"VersionInfo.ts not found at {version_info_path}")

    with open(version_info_path, "r") as f:
        ts_content = f.read()

    # Extract the TypeScript version using regex
    ts_version_match = re.search(r'VISER_VERSION\s*=\s*["\']([^"\']+)["\']', ts_content)
    assert ts_version_match, "Could not find VISER_VERSION in VersionInfo.ts"
    ts_version = ts_version_match.group(1)

    # Verify versions match
    assert py_version == ts_version, (
        f"Version mismatch: {py_version} in __init__.py does not match "
        f"{ts_version} in VersionInfo.ts. Run 'python sync_client_server.py' to update."
    )
