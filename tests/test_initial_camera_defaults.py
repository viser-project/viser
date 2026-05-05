"""Test that initial camera defaults match between Python and TypeScript."""

from __future__ import annotations

import math
import re
from pathlib import Path

import pytest

from viser._viser import InitialCameraConfig


def test_initial_camera_defaults_match():
    """Verify that InitialCameraConfig defaults match InitialCameraState.ts defaults."""
    # Get the Python defaults. Pass a no-op broadcast function.
    config = InitialCameraConfig(broadcast=lambda _: None)
    py_defaults = {
        "position": config.position,
        "look_at": config.look_at,
        "up": config.up,
        "fov": config.fov,
        "near": config.near,
        "far": config.far,
    }

    # Parse TypeScript defaults from InitialCameraState.ts.
    repo_root = Path(__file__).parent.parent
    ts_path = repo_root / "src" / "viser" / "client" / "src" / "InitialCameraState.ts"

    if not ts_path.exists():
        pytest.skip(f"InitialCameraState.ts not found at {ts_path}")

    ts_content = ts_path.read_text()

    # Parse vector defaults by finding lines with the pattern:
    # : { value: [x, y, z], source: "default" as const },
    # We search for the property name followed by its default block.
    def parse_vec3(name: str) -> tuple[float, float, float]:
        # Find the block for this property by looking for:
        # {name}: urlParams.{name}
        #   ? ...
        #   : { value: [...], source: "default" as const },
        # We use a simpler approach: find all default vec3 patterns and match by order.
        pattern = (
            r':\s*\{\s*value:\s*\[([^\]]+)\],\s*source:\s*"default"\s*as\s*const\s*\}'
        )
        matches = re.findall(pattern, ts_content)

        # Map property names to their index in the file order.
        prop_order = ["position", "lookAt", "up"]
        if name not in prop_order:
            raise ValueError(f"Unknown vec3 property: {name}")
        idx = prop_order.index(name)
        assert idx < len(matches), (
            f"Could not find default {name} in InitialCameraState.ts"
        )

        values = [float(v.strip()) for v in matches[idx].split(",")]
        assert len(values) == 3, f"Expected 3 values for {name}, got {len(values)}"
        return (values[0], values[1], values[2])

    # Parse scalar defaults, handling expressions like (50.0 * Math.PI) / 180.0
    def parse_scalar(name: str) -> float:
        # Find all default scalar patterns.
        pattern = (
            r':\s*\{\s*value:\s*([^,\[\]]+),\s*source:\s*"default"\s*as\s*const\s*\}'
        )
        matches = re.findall(pattern, ts_content)

        # Map property names to their index in the file order (after vec3s).
        prop_order = ["fov", "near", "far"]
        if name not in prop_order:
            raise ValueError(f"Unknown scalar property: {name}")
        idx = prop_order.index(name)
        assert idx < len(matches), (
            f"Could not find default {name} in InitialCameraState.ts"
        )

        expr = matches[idx].strip()
        # Evaluate simple math expressions with Math.PI.
        expr = expr.replace("Math.PI", str(math.pi))
        return float(eval(expr))  # noqa: S307

    ts_defaults = {
        "position": parse_vec3("position"),
        "lookAt": parse_vec3("lookAt"),
        "up": parse_vec3("up"),
        "fov": parse_scalar("fov"),
        "near": parse_scalar("near"),
        "far": parse_scalar("far"),
    }

    # Compare values with tolerance for floating point.
    def assert_close(name: str, py_val: float, ts_val: float) -> None:
        assert math.isclose(py_val, ts_val, rel_tol=1e-9), (
            f"{name} mismatch: Python={py_val}, TypeScript={ts_val}"
        )

    def assert_vec3_close(
        name: str,
        py_val: tuple[float, float, float],
        ts_val: tuple[float, float, float],
    ) -> None:
        for i, (p, t) in enumerate(zip(py_val, ts_val)):
            assert math.isclose(p, t, rel_tol=1e-9), (
                f"{name}[{i}] mismatch: Python={p}, TypeScript={t}"
            )

    # Check all values match.
    assert_vec3_close("position", py_defaults["position"], ts_defaults["position"])
    assert_vec3_close("look_at", py_defaults["look_at"], ts_defaults["lookAt"])
    # Skip up comparison: Python default is None (meaning "same as scene up direction"),
    # while TypeScript has a concrete default [0, 1, 0] in three.js coordinates.
    assert py_defaults["up"] is None
    assert_close("fov", py_defaults["fov"], ts_defaults["fov"])
    assert_close("near", py_defaults["near"], ts_defaults["near"])
    assert_close("far", py_defaults["far"], ts_defaults["far"])
