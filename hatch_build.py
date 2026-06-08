import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    generated_build_dir: Path | None = None

    def initialize(self, version: str, build_data: dict[str, object]) -> None:
        if os.environ.get("VISER_SKIP_CLIENT_BUILD") == "1":
            return

        root = Path(self.root)
        client_dir = root / "src" / "viser" / "client"
        if not (client_dir / "package.json").exists():
            return

        with tempfile.TemporaryDirectory(prefix="viser-client-build-") as temp_dir:
            temp_client_dir = Path(temp_dir) / "client"
            shutil.copytree(
                client_dir,
                temp_client_dir,
                ignore=shutil.ignore_patterns(".nodeenv", "node_modules", "build"),
            )

            build_client(temp_client_dir)

            build_dir = client_dir / "build"
            shutil.rmtree(build_dir, ignore_errors=True)
            shutil.copytree(temp_client_dir / "build", build_dir)
            self.generated_build_dir = build_dir

    def finalize(
        self, version: str, build_data: dict[str, object], artifact_path: str
    ) -> None:
        if self.generated_build_dir is not None:
            shutil.rmtree(self.generated_build_dir, ignore_errors=True)


def build_client(client_dir: Path) -> None:
    node_bin_dir = install_sandboxed_node(client_dir)
    npm_path = node_bin_dir / "npm"
    if sys.platform == "win32":
        npm_path = npm_path.with_suffix(".cmd")

    env = os.environ.copy()
    env["NODE_VIRTUAL_ENV"] = str(node_bin_dir.parent)
    env["PATH"] = (
        str(node_bin_dir) + (";" if sys.platform == "win32" else ":") + env["PATH"]
    )

    subprocess.run([str(npm_path), "ci"], cwd=client_dir, env=env, check=True)
    subprocess.run(
        [str(npm_path), "run", "build"],
        cwd=client_dir,
        env=env,
        check=True,
    )


def install_sandboxed_node(client_dir: Path) -> Path:
    env_dir = client_dir / ".nodeenv"

    def get_node_bin_dir() -> Path:
        node_bin_dir = env_dir / "bin"
        if not node_bin_dir.exists():
            node_bin_dir = env_dir / "Scripts"
        return node_bin_dir

    node_bin_dir = get_node_bin_dir()

    npx_path = node_bin_dir / "npx"
    if sys.platform == "win32":
        npx_path = npx_path.with_suffix(".cmd")
    if npx_path.exists():
        return node_bin_dir

    subprocess.run(
        [sys.executable, "-m", "nodeenv", "--node=24.12.0", str(env_dir)],
        check=True,
    )
    node_bin_dir = get_node_bin_dir()
    npx_path = node_bin_dir / "npx"
    if sys.platform == "win32":
        npx_path = npx_path.with_suffix(".cmd")
    if not npx_path.exists():
        raise RuntimeError(f"nodeenv did not create {npx_path}")
    return node_bin_dir
