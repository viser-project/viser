import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

client_dir = Path(__file__).absolute().parent / "client"
build_dir = client_dir / "build"


def _is_editable_install() -> bool:
    """Check if viser is installed in editable mode.

    In editable installs, __file__ is in src/viser/ within the source tree.
    In regular installs, __file__ is in site-packages/viser/.
    """
    viser_dir = Path(__file__).parent
    return viser_dir.name == "viser" and viser_dir.parent.name == "src"


def _check_viser_dev_running() -> bool:
    """Returns True if the viewer client has been launched via `npm run dev`."""
    try:
        import psutil
    except ImportError:
        # If psutil is not installed, we can't check for dev server.
        # This is fine for normal usage - only needed for development.
        return False

    for process in psutil.process_iter():
        try:
            # Check if the process is running from the correct viser client directory
            # and is actually a vite dev server (not just any vite command)
            cwd = Path(process.cwd()).resolve()
            expected_cwd = client_dir.resolve()

            if cwd == expected_cwd:
                cmdline = process.cmdline()
                # Check for vite with --host flag (which is our dev command)
                # Make sure it's not a build command
                has_vite = any("vite" in part for part in cmdline)
                has_host = any("--host" in part for part in cmdline)
                not_build = not any("build" in part for part in cmdline)

                if has_vite and has_host and not_build:
                    return True
        except (psutil.AccessDenied, psutil.ZombieProcess, psutil.NoSuchProcess):
            pass
    return False


def ensure_client_is_built() -> None:
    """Ensure that the client is built or already running."""

    # For non-editable installs, just verify the build exists.
    # Skip timestamp checks and dev server detection.
    if not _is_editable_install() and (build_dir / "index.html").exists():
        return

    if not (client_dir / "src").exists():
        # Can't build client.
        assert (build_dir / "index.html").exists(), (
            "Something went wrong! At least one of the client source or build"
            " directories should be present."
        )
        return

    # Do we need to re-trigger a build?
    build = False
    if _check_viser_dev_running():
        # Don't run build if dev server is already running.
        import rich

        rich.print(
            "[bold](viser)[/bold] The Viser viewer looks like it has been launched via"
            " `npm run dev`. Skipping build check..."
        )
        build = False
    elif not (build_dir / "index.html").exists():
        import rich

        rich.print("[bold](viser)[/bold] No client build found. Building now...")
        build = True
    elif (
        # We should be at least 10 seconds newer than the last build.
        # This buffer is important when we install from pip, and the src/ +
        # build/ directories have very similar timestamps.
        _modified_time_recursive(client_dir / "src")
        > _modified_time_recursive(build_dir) + 10.0
    ):
        import rich

        rich.print(
            "[bold](viser)[/bold] Client build looks out of date. Building now..."
        )
        build = True

    # Install nodejs and build if necessary. We assume bash is installed.
    if build:
        _build_viser_client(out_dir=build_dir, cached=False)


def _build_viser_client(out_dir: Path, cached: bool = True) -> None:
    """Create a build of the Viser client.

    Args:
        out_dir: The directory to write the built client to.
        cached: If True, skip the build if the client is already built.
            Instead, we'll simply copy the previous build to the new location.
    """

    if cached and build_dir.exists() and (build_dir / "index.html").exists():
        import rich

        rich.print(
            f"[bold](viser)[/bold] Copying client build from {build_dir} to {out_dir}."
        )
        shutil.copytree(build_dir, out_dir)
        return

    node_bin_dir = _install_sandboxed_node()
    npx_path = node_bin_dir / "npx"

    subprocess_env = os.environ.copy()
    subprocess_env["NODE_VIRTUAL_ENV"] = str(node_bin_dir.parent)
    subprocess_env["PATH"] = (
        str(node_bin_dir)
        + (";" if sys.platform == "win32" else ":")
        + subprocess_env["PATH"]
    )
    npm_path = node_bin_dir / "npm"

    if sys.platform == "win32":
        npx_path = npx_path.with_suffix(".cmd")
        npm_path = npm_path.with_suffix(".cmd")

    subprocess.run(
        args=[str(npm_path), "install"],
        env=subprocess_env,
        cwd=client_dir,
        check=False,
    )
    subprocess.run(
        args=[
            str(npx_path),
            "vite",
            "build",
            "--base",
            "./",
            "--outDir",
            # Relative path needs to be made absolute, since we change the CWD.
            str(out_dir.absolute()),
        ],
        env=subprocess_env,
        cwd=client_dir,
        check=False,
    )


def build_client_entrypoint() -> None:
    """Build the Viser client entrypoint, which is used to launch the viewer."""
    parser = argparse.ArgumentParser(description="Build the Viser client.")
    parser.add_argument("--out-dir", required=True)
    parser.add_argument(
        "--no-cached",
        action="store_false",
        help="If set, skip the build if the client is already built.",
    )
    args = parser.parse_args()
    out_dir = Path(args.out_dir) if args.out_dir else build_dir
    _build_viser_client(out_dir=out_dir, cached=args.no_cached)


def _install_sandboxed_node() -> Path:
    """Install a sandboxed copy of nodejs using nodeenv, and return a path to the
    environment's bin directory (`.nodeenv/bin` or `.nodeenv/Scripts`).

    On Windows, the `.nodeenv/bin` does not exist. Instead, executables are
    installed to `.nodeenv/Scripts`."""

    def get_node_bin_dir() -> Path:
        env_dir = client_dir / ".nodeenv"
        node_bin_dir = env_dir / "bin"
        if not node_bin_dir.exists():
            node_bin_dir = env_dir / "Scripts"
        return node_bin_dir

    node_bin_dir = get_node_bin_dir()
    if (node_bin_dir / "npx").exists():
        import rich

        rich.print("[bold](viser)[/bold] nodejs is set up!")
        return node_bin_dir

    env_dir = client_dir / ".nodeenv"
    result = subprocess.run(
        [sys.executable, "-m", "nodeenv", "--node=24.12.0", env_dir], check=False
    )

    if result.returncode != 0:
        raise RuntimeError(
            "Failed to install Node.js using nodeenv. "
            "To rebuild the Viser client, install nodeenv with: "
            "pip install 'nodeenv>=1.9.1'"
        )

    node_bin_dir = get_node_bin_dir()
    assert (node_bin_dir / "npx").exists()
    return node_bin_dir


def _modified_time_recursive(dir: Path) -> float:
    """Recursively get the last time a file was modified in a directory."""
    return max([f.stat().st_mtime for f in dir.glob("**/*")])
