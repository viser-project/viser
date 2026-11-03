"""Correctness and lifecycle tests for shared-geometry URDF batches."""

from __future__ import annotations

import io
import json
from pathlib import Path
from unittest.mock import patch

import numpy as np
import pytest
import trimesh
from PIL import Image
from trimesh.visual import TextureVisuals
from trimesh.visual.material import PBRMaterial

import viser
import viser.transforms as tf
from viser.extras import BatchedViserUrdf, ViserUrdf

from .infra_utils import make_synthetic_client

yourdfpy = pytest.importorskip("yourdfpy")
URDF_PATH = Path(__file__).parents[1] / "examples/assets/batched_arm.urdf"


@pytest.fixture
def server():
    with patch("viser._client_autobuild.ensure_client_is_built"):
        server = viser.ViserServer(host="127.0.0.1", port=0, verbose=False)
    try:
        yield server
    finally:
        server.stop()


def _pose(wxyz, position):
    matrix = np.eye(4)
    matrix[:3, :3] = tf.SO3(np.asarray(wxyz)).as_matrix()
    matrix[:3, 3] = position
    return matrix


def _node_world_transform(server, name):
    transform = np.eye(4)
    while name:
        handle = server.scene.get_handle_by_name(name)
        if handle is not None:
            transform = _pose(handle.wxyz, handle.position) @ transform
        name = name.rsplit("/", 1)[0]
    return transform


def _glb_vertices(data):
    scene = trimesh.load(io.BytesIO(data), file_type="glb", force="scene")
    assert isinstance(scene, trimesh.Scene)
    return np.concatenate(
        [
            trimesh.transform_points(scene.geometry[geometry].vertices, matrix)
            for node in scene.graph.nodes_geometry
            for matrix, geometry in [scene.graph.get(node)]
        ]
    )


def _sorted_vertices(vertices):
    # GLB loading can reorder vertices. Match points independently of topology.
    return vertices[np.lexsort(np.round(vertices, 6).T[::-1])]


@pytest.mark.parametrize("num_robots", [1, 3])
@pytest.mark.parametrize("bases_first", [False, True])
def test_world_geometry_matches_independent_viser_urdf(server, num_robots, bases_first):
    model = yourdfpy.URDF.load(URDF_PATH)
    batch = BatchedViserUrdf(server, model, num_robots, root_node_name="/batch")
    assert batch.get_actuated_joint_names() == ("shoulder", "extension")
    assert len(batch._meshes) == 6  # Includes two visuals on the base link.
    root_wxyz = tf.SO3.from_rpy_radians(0.2, -0.3, 0.4).wxyz
    root_position = np.array([0.7, -1.0, 0.5])
    root = server.scene.get_handle_by_name("/batch")
    root.wxyz, root.position = root_wxyz, root_position
    wxyzs = tf.SO3.from_z_radians(np.linspace(0.1, 1.2, num_robots)).wxyz
    positions = np.arange(num_robots * 3).reshape(num_robots, 3) * 0.2
    cfg = np.stack(
        [np.linspace(-0.4, 0.7, num_robots), np.linspace(0.02, 0.2, num_robots)],
        axis=-1,
    )
    if bases_first:
        batch.update_base_poses(batched_wxyzs=wxyzs, batched_positions=positions)
    batch.update_cfg(cfg)
    if not bases_first:
        batch.update_base_poses(batched_wxyzs=wxyzs, batched_positions=positions)

    for i in range(num_robots):
        base = _pose(root_wxyz, root_position) @ _pose(wxyzs[i], positions[i])
        server.scene.add_frame(
            f"/reference_{i}",
            wxyz=tf.SO3.from_matrix(base[:3, :3]).wxyz,
            position=base[:3, 3],
        )
        reference = ViserUrdf(
            server, yourdfpy.URDF.load(URDF_PATH), root_node_name=f"/reference_{i}"
        )
        reference.update_cfg(cfg[i])
        assert (
            batch.get_actuated_joint_limits() == reference.get_actuated_joint_limits()
        )
        for batched, single in zip(batch._meshes, reference._meshes):
            assert isinstance(single, viser.GlbHandle)
            actual = trimesh.transform_points(
                _glb_vertices(batched.glb_data),
                _node_world_transform(server, batched.name)
                @ _pose(batched.batched_wxyzs[i], batched.batched_positions[i]),
            )
            expected = trimesh.transform_points(
                _glb_vertices(single.glb_data),
                _node_world_transform(server, single.name),
            )
            np.testing.assert_allclose(
                _sorted_vertices(actual), _sorted_vertices(expected), atol=2e-6
            )


def test_initial_configuration_and_input_ownership(server):
    model = yourdfpy.URDF.load(URDF_PATH)
    model.update_cfg(np.array([0.7, 0.12]))
    old_cfg = model.cfg.copy()
    old_vertices = {
        name: mesh.vertices.copy() for name, mesh in model.scene.geometry.items()
    }
    batch = BatchedViserUrdf(server, model, 2)
    for link_index, link in enumerate(batch._link_names):
        expected = model.get_transform(link)
        np.testing.assert_allclose(
            batch._link_transforms[:, link_index], [expected, expected]
        )
    positions = np.array([[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])
    wxyzs = np.array([[2.0, 0, 0, 0], [2.0, 0, 0, 0]])
    # Base-only updates use cached FK, even before the first explicit cfg update.
    with patch.object(
        batch._urdf, "update_cfg", side_effect=AssertionError("unexpected FK")
    ):
        batch.update_base_poses(batched_wxyzs=wxyzs, batched_positions=positions)
    np.testing.assert_array_equal(wxyzs[:, 0], [2, 2])
    positions[:] = 0
    wxyzs[:] = 0
    np.testing.assert_array_equal(batch._base_positions[0], [1, 2, 3])
    cfg = np.array([[0.1, 0.2], [-0.5, 0.1]])
    batch.update_cfg(cfg)
    np.testing.assert_array_equal(cfg, [[0.1, 0.2], [-0.5, 0.1]])
    np.testing.assert_array_equal(model.cfg, old_cfg)
    for name, mesh in model.scene.geometry.items():
        np.testing.assert_array_equal(mesh.vertices, old_vertices[name])


def test_scaled_reflected_asset_and_distinct_geometry_node(server, tmp_path):
    mesh = trimesh.creation.box(extents=[0.1, 0.2, 0.3])
    mesh.export(tmp_path / "box.obj")
    path = tmp_path / "scaled.urdf"
    path.write_text("""<robot name="scaled"><link name="base"><visual name="asset">
      <origin xyz="0.2 0.3 0.4" rpy="0.2 0.4 0.6"/>
      <geometry><mesh filename="box.obj" scale="2 3 -4"/></geometry>
      </visual></link></robot>""")
    model = yourdfpy.URDF.load(path, mesh_dir=str(tmp_path))
    node = model.scene.graph.nodes_geometry[0]
    transform, geometry = model.scene.graph.get(node)
    # A second instance of one geometry asset has a different node name.
    extra = transform.copy()
    extra[:3, 3] += [1, 0, 0]
    model.scene.graph.update(
        frame_from="base", frame_to="second_node", matrix=extra, geometry=geometry
    )
    batch = BatchedViserUrdf(server, model, 2)
    assert len(batch._meshes) == 2
    for handle, node in zip(batch._meshes, model.scene.graph.nodes_geometry):
        transform, geometry = model.scene.graph.get(node)
        expected = trimesh.transform_points(
            model.scene.geometry[geometry].vertices, transform
        )
        actual = _glb_vertices(handle.glb_data)
        np.testing.assert_allclose(
            _sorted_vertices(actual), _sorted_vertices(expected), atol=1e-6
        )
    # Also exercise the path-loading branch with filename resolution.
    path_batch = BatchedViserUrdf(server, path, 1, root_node_name="/from_path")
    assert len(path_batch._meshes) == 1


def _glb_json(data):
    length = int.from_bytes(data[12:16], "little")
    return json.loads(data[20 : 20 + length])


def test_materials_and_geometry_exported_once(server, monkeypatch):
    model = yourdfpy.URDF.load(URDF_PATH)
    mesh = next(iter(model.scene.geometry.values()))
    mesh.visual = TextureVisuals(
        uv=np.zeros((len(mesh.vertices), 2)),
        material=PBRMaterial(
            baseColorTexture=Image.new("RGBA", (2, 2), (80, 120, 160, 100)),
            baseColorFactor=[1.0, 1.0, 1.0, 0.4],
            metallicFactor=0.2,
            roughnessFactor=0.7,
            alphaMode="BLEND",
            doubleSided=True,
        ),
    )
    count = 0
    original_export = trimesh.Trimesh.export

    def export(self, *args, **kwargs):
        nonlocal count
        count += 1
        return original_export(self, *args, **kwargs)

    monkeypatch.setattr(trimesh.Trimesh, "export", export)
    batch = BatchedViserUrdf(server, model, 16)
    assert count == len(model.scene.graph.nodes_geometry)
    glbs = [handle.glb_data for handle in batch._meshes]
    for i in range(3):
        batch.update_cfg(np.tile([0.1 * i, 0.02 * i], (16, 1)))
        batch.update_cfg(np.array([[0.03 * i, 0.01 * i]]), robot_indices=np.array([15]))
    assert count == len(glbs)
    assert glbs == [handle.glb_data for handle in batch._meshes]
    data = _glb_json(glbs[0])
    material = data["materials"][0]
    assert material["alphaMode"] == "BLEND"
    assert material["doubleSided"]
    assert material["pbrMetallicRoughness"]["roughnessFactor"] == 0.7
    assert "baseColorTexture" in material["pbrMetallicRoughness"]
    assert "TEXCOORD_0" in data["meshes"][0]["primitives"][0]["attributes"]
    assert len(data["images"]) == 1


@pytest.mark.parametrize(
    "invalid",
    [np.zeros((2, 3)), np.zeros((2,)), [[np.nan, 0], [0, 0]], [[np.inf, 0], [0, 0]]],
)
def test_invalid_cfg_does_not_partially_update(server, invalid):
    batch = BatchedViserUrdf(server, URDF_PATH, 2)
    before = [
        (h.batched_wxyzs.copy(), h.batched_positions.copy()) for h in batch._meshes
    ]
    with pytest.raises(ValueError, match="finite array with shape"):
        batch.update_cfg(invalid)
    for handle, (wxyzs, positions) in zip(batch._meshes, before):
        np.testing.assert_array_equal(handle.batched_wxyzs, wxyzs)
        np.testing.assert_array_equal(handle.batched_positions, positions)


@pytest.mark.parametrize("client_scoped", [False, True])
def test_external_atomic_and_parallel_update_finish_without_lock_inversion(
    server, client_scoped, monkeypatch
):
    """Coordinate the alleged ABBA ordering instead of relying on timing sleeps."""
    import threading

    target = make_synthetic_client(server, 103) if client_scoped else server
    batch = BatchedViserUrdf(target, URDF_PATH, 2, root_node_name="/atomic_order")
    outer_entered = threading.Event()
    helper_at_publish = threading.Event()
    outer_about_to_update = threading.Event()
    errors = []
    original_publish = batch._publish_poses

    def publish(wxyzs, positions):
        if threading.current_thread().name == "helper-first":
            # update_cfg holds the helper RLock here, before target.atomic().
            helper_at_publish.set()
            if not outer_about_to_update.wait(3):
                raise TimeoutError("outer atomic worker did not reach update")
        original_publish(wxyzs, positions)

    monkeypatch.setattr(batch, "_publish_poses", publish)

    def outer_first():
        try:
            with target.atomic():
                outer_entered.set()
                if not helper_at_publish.wait(3):
                    raise TimeoutError("helper worker did not reach publishing")
                outer_about_to_update.set()
                batch.update_cfg(np.array([[0.4, 0.12]]), robot_indices=np.array([1]))
        except BaseException as error:
            errors.append(error)

    def helper_first():
        try:
            if not outer_entered.wait(3):
                raise TimeoutError("outer atomic worker did not enter context")
            batch.update_cfg(np.array([[0.2, 0.08]]), robot_indices=np.array([0]))
        except BaseException as error:
            errors.append(error)

    workers = [
        threading.Thread(target=outer_first, name="outer-first", daemon=True),
        threading.Thread(target=helper_first, name="helper-first", daemon=True),
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=4)
    assert not any(worker.is_alive() for worker in workers), (
        "atomic/helper lock inversion"
    )
    assert not errors
    connection = target._websock_connection if client_scoped else server._websock_server
    assert connection.get_message_buffer().atomic_counter == 0
    reference = yourdfpy.URDF.load(URDF_PATH)
    for row, configuration in enumerate([[0.2, 0.08], [0.4, 0.12]]):
        reference.update_cfg(np.array(configuration))
        for link_index, link in enumerate(batch._link_names):
            np.testing.assert_allclose(
                batch._link_transforms[row, link_index], reference.get_transform(link)
            )


@pytest.mark.parametrize("quaternion_scale", [1e-300, 1e300])
def test_readonly_strided_inputs_and_extreme_quaternion_scales(
    server, quaternion_scale
):
    """Accept real views/unsigned indices without aliasing or norm under/overflow."""
    batch = BatchedViserUrdf(server, URDF_PATH, 4)
    index_storage = np.array([3, 0, 1, 0], dtype=np.uint16)
    indices = index_storage[::2]
    cfg_storage = np.zeros((4, 4), dtype=np.float32)
    cfg = cfg_storage[::2, ::2]
    cfg[:] = [[0.3, 0.12], [-0.4, 0.2]]
    position_storage = np.zeros((4, 6))
    positions = position_storage[::2, ::2]
    positions[:] = [[0.4, 0.5, 0.6], [-0.5, -0.4, 0.3]]
    quaternion_storage = np.zeros((4, 8))
    wxyzs = quaternion_storage[::2, ::2]
    wxyzs[:] = np.array([[1, 1, 0, 0], [-1, 0, 0, 1]]) * quaternion_scale
    for value in (indices, cfg, positions, wxyzs):
        value.flags.writeable = False
        assert not value.flags.c_contiguous
    before = [
        (handle.batched_wxyzs.copy(), handle.batched_positions.copy())
        for handle in batch._meshes
    ]
    with np.errstate(all="raise"):
        batch.update_cfg(cfg, robot_indices=indices)
        batch.update_base_poses(
            batched_wxyzs=wxyzs, batched_positions=positions, robot_indices=indices
        )
    expected_wxyzs = np.array([[1, 1, 0, 0], [-1, 0, 0, 1]]) / np.sqrt(2)
    np.testing.assert_allclose(batch._base_wxyzs[[3, 1]], expected_wxyzs)
    np.testing.assert_array_equal(batch._base_positions[[3, 1]], positions)
    for handle, (old_wxyzs, old_positions) in zip(batch._meshes, before):
        np.testing.assert_array_equal(handle.batched_wxyzs[[0, 2]], old_wxyzs[[0, 2]])
        np.testing.assert_array_equal(
            handle.batched_positions[[0, 2]], old_positions[[0, 2]]
        )
        assert handle.batched_wxyzs.dtype == np.float32
        assert handle.batched_positions.dtype == np.float32
    # Mutate backing storage to prove these read-only views were copied.
    index_storage[:] = 0
    cfg_storage[:] = 0
    quaternion_storage[:] = 0
    position_storage[:] = 0
    np.testing.assert_allclose(batch._base_wxyzs[[3, 1]], expected_wxyzs)
    np.testing.assert_array_equal(
        batch._base_positions[[3, 1]], [[0.4, 0.5, 0.6], [-0.5, -0.4, 0.3]]
    )


def test_constructor_export_failure_cleans_owned_subtree(server, monkeypatch):
    """A third mesh export failure must release partial handles and atomic state."""
    root = server.scene.add_frame("/failed_batch")
    sibling = server.scene.add_frame("/failed_batch/sibling")
    original_export = trimesh.Trimesh.export
    exports = 0

    def fail_third_export(mesh, *args, **kwargs):
        nonlocal exports
        exports += 1
        if exports == 3:
            raise RuntimeError("injected third visual export failure")
        return original_export(mesh, *args, **kwargs)

    with monkeypatch.context() as context:
        context.setattr(trimesh.Trimesh, "export", fail_third_export)
        with pytest.raises(RuntimeError, match="third visual export failure"):
            BatchedViserUrdf(server, URDF_PATH, 2, root_node_name=root.name)
    assert exports == 3
    assert server.scene.get_handle_by_name(root.name) is root
    assert server.scene.get_handle_by_name(sibling.name) is sibling
    assert server.scene.get_handle_by_name(root.name + "/visual") is None
    for index in range(6):
        assert (
            server.scene.get_handle_by_name(f"{root.name}/visual/mesh_{index}") is None
        )
    assert server._websock_server.get_message_buffer().atomic_counter == 0
    recreated = BatchedViserUrdf(server, URDF_PATH, 2, root_node_name=root.name)
    recreated.update_cfg(np.array([[0.2, 0.1], [-0.3, 0.15]]))
    recreated.remove()
    assert server.scene.get_handle_by_name(root.name) is root
    assert server.scene.get_handle_by_name(sibling.name) is sibling
    assert server.scene.get_handle_by_name(root.name + "/visual") is None
    assert server._websock_server.get_message_buffer().atomic_counter == 0


@pytest.mark.parametrize(
    "field,invalid",
    [
        ("batched_wxyzs", np.zeros((2, 4))),
        ("batched_wxyzs", np.ones((1, 4))),
        ("batched_wxyzs", np.full((2, 4), np.nan)),
        ("batched_positions", np.full((2, 3), np.inf)),
        ("batched_positions", np.zeros((2, 2))),
    ],
)
def test_invalid_bases_do_not_partially_update(server, field, invalid):
    batch = BatchedViserUrdf(server, URDF_PATH, 2)
    before = batch._base_positions.copy(), batch._base_wxyzs.copy()
    args = dict(
        batched_wxyzs=np.tile([1.0, 0, 0, 0], (2, 1)),
        batched_positions=np.zeros((2, 3)),
    )
    args[field] = invalid
    with pytest.raises(ValueError):
        batch.update_base_poses(**args)
    np.testing.assert_array_equal(batch._base_positions, before[0])
    np.testing.assert_array_equal(batch._base_wxyzs, before[1])


@pytest.mark.parametrize("count", [0, -1, 1.5, True])
def test_invalid_count(server, count):
    with pytest.raises(ValueError, match="positive integer"):
        BatchedViserUrdf(server, URDF_PATH, count)


@pytest.mark.parametrize("root", ["robot", "/robot/"])
def test_invalid_root(server, root):
    with pytest.raises(ValueError, match="root_node_name"):
        BatchedViserUrdf(server, URDF_PATH, 1, root_node_name=root)


@pytest.mark.parametrize("joint_type", ["floating", "planar"])
def test_unsupported_joints(server, joint_type):
    model = yourdfpy.URDF.load(URDF_PATH)
    model.robot.joints[0].type = joint_type
    with pytest.raises(ValueError, match="Unsupported joint type"):
        BatchedViserUrdf(server, model, 1)


def test_static_robot_and_empty_visual_scene(server):
    for visual in (
        [],
        [yourdfpy.Visual(geometry=yourdfpy.Geometry(box=yourdfpy.Box(size=[1, 1, 1])))],
    ):
        model = yourdfpy.URDF(
            yourdfpy.Robot("static", links=[yourdfpy.Link("base", visuals=visual)])
        )
        batch = BatchedViserUrdf(server, model, 2)
        batch.update_cfg(np.empty((2, 0)))
        batch.update_cfg(np.empty((1, 0)), robot_indices=np.array([1]))
        batch.update_base_poses(
            batched_wxyzs=np.array([[1.0, 0, 0, 0]]),
            batched_positions=np.ones((1, 3)),
            robot_indices=np.array([1]),
        )
        assert batch.get_actuated_joint_names() == ()
        assert batch.get_actuated_joint_limits() == {}
        batch.remove()
    model = yourdfpy.URDF.load(URDF_PATH, build_scene_graph=False)
    with pytest.raises(ValueError, match="visual scene"):
        BatchedViserUrdf(server, model, 1)


def test_lifecycle_and_namespace_ownership(server):
    root = server.scene.add_frame("/robot")
    sibling = server.scene.add_frame("/robot/sibling")
    batch = BatchedViserUrdf(server, URDF_PATH, 1, root_node_name="/robot")
    assert batch.show_visual
    batch.show_visual = False
    assert not batch.show_visual
    batch.show_visual = True
    batch.remove()
    batch.remove()
    assert not batch.show_visual
    assert server.scene.get_handle_by_name(root.name) is root
    assert server.scene.get_handle_by_name(sibling.name) is sibling
    assert server.scene.get_handle_by_name("/robot/visual") is None
    with pytest.raises(RuntimeError, match="removed or replaced"):
        batch.update_cfg(np.zeros((1, 2)))
    with pytest.raises(RuntimeError, match="removed or replaced"):
        batch.show_visual = True
    # A stale helper must not delete its same-name replacement.
    old = BatchedViserUrdf(server, URDF_PATH, 1, root_node_name="/robot")
    new = BatchedViserUrdf(server, URDF_PATH, 1, root_node_name="/robot")
    old.remove()
    assert new.show_visual
    root.remove()
    assert not new.show_visual
    new.remove()


def test_client_scope_isolation(server):
    client = make_synthetic_client(server, 101)
    server_batch = BatchedViserUrdf(server, URDF_PATH, 1, root_node_name="/same")
    client_batch = BatchedViserUrdf(client, URDF_PATH, 2, root_node_name="/same")
    client_batch.update_cfg(np.array([[0.5, 0.1], [-0.5, 0.2]]))
    client_batch.update_cfg(np.array([[0.2, 0.15]]), robot_indices=np.array([1]))
    client_batch.update_base_poses(
        batched_wxyzs=np.array([[1.0, 0, 0, 0]]),
        batched_positions=np.ones((1, 3)),
        robot_indices=np.array([1]),
    )
    np.testing.assert_array_equal(server_batch._urdf.cfg, [0, 0])
    client_batch.remove()
    assert server_batch.show_visual
    assert (
        server.scene.get_handle_by_name("/same/visual")
        is server_batch._visual_root_frame
    )
    assert client.scene.get_handle_by_name("/same/visual") is None


def test_replacement_with_fewer_visuals_removes_old_geometry(server):
    old = BatchedViserUrdf(server, URDF_PATH, 1)
    model = yourdfpy.URDF(
        yourdfpy.Robot(
            "one_visual",
            links=[
                yourdfpy.Link(
                    "base",
                    visuals=[
                        yourdfpy.Visual(
                            geometry=yourdfpy.Geometry(box=yourdfpy.Box(size=[1, 1, 1]))
                        )
                    ],
                )
            ],
        )
    )
    new = BatchedViserUrdf(server, model, 1)
    old.remove()
    assert new.show_visual
    assert server.scene.get_handle_by_name("/visual/mesh_0") is new._meshes[0]
    assert server.scene.get_handle_by_name("/visual/mesh_1") is None


def test_unrepresentable_positions_fail_before_any_change(server):
    batch = BatchedViserUrdf(server, URDF_PATH, 1)
    before = [
        (h.batched_positions.copy(), h.batched_wxyzs.copy()) for h in batch._meshes
    ]
    with pytest.raises(ValueError, match="fit in float32"):
        batch.update_base_poses(
            batched_wxyzs=np.array([[1, 0, 0, 0]]),
            batched_positions=np.full((1, 3), 1e100),
        )
    np.testing.assert_array_equal(batch._base_positions, [[0, 0, 0]])
    with pytest.raises(ValueError, match="fit in float32"):
        batch.update_cfg(np.array([[0.5, 1e100]]))
    for handle, (positions, wxyzs) in zip(batch._meshes, before):
        np.testing.assert_array_equal(handle.batched_positions, positions)
        np.testing.assert_array_equal(handle.batched_wxyzs, wxyzs)
    batch.update_cfg(np.array([[0.2, 0.1]]))  # Recovery after a rejected update.


def test_analytic_continuous_and_prismatic_transforms(server):
    model = yourdfpy.URDF.load(URDF_PATH)
    model.robot.joints[0].type = "continuous"
    batch = BatchedViserUrdf(server, model, 2)
    cfg = np.array([[0.6, 0.12], [-0.2, 0.25]])
    batch.update_cfg(cfg)
    for i, (angle, extension) in enumerate(cfg):
        shoulder = _pose(tf.SO3.from_y_radians(angle).wxyz, [0, 0, 0.24])
        # URDF origin comes before the prismatic translation.
        slider = (
            shoulder
            @ _pose(tf.SO3.from_y_radians(0.15).wxyz, [0, 0, 0.5])
            @ _pose([1, 0, 0, 0], [extension, 0, 0])
        )
        np.testing.assert_allclose(
            batch._link_transforms[i, batch._link_names.index("arm")],
            shoulder,
            atol=1e-7,
        )
        np.testing.assert_allclose(
            batch._link_transforms[i, batch._link_names.index("slider")],
            slider,
            atol=1e-7,
        )


@pytest.mark.parametrize("indices", [np.array([3, 1]), np.array([3, 1, 0, 2])])
@pytest.mark.parametrize("bases_first", [False, True])
def test_indexed_updates_match_full_updates_and_preserve_other_rows(
    server, indices, bases_first
):
    indices = indices.copy()
    batch = BatchedViserUrdf(
        server,
        URDF_PATH,
        4,
        root_node_name="/indexed",
    )
    reference = BatchedViserUrdf(server, URDF_PATH, 4, root_node_name="/full")
    cfg = np.array([[0.2, 0.03], [0.3, 0.05], [-0.4, 0.07], [-0.7, 0.1]])
    wxyzs = tf.SO3.from_rpy_radians(
        np.arange(4) * 0.1, np.arange(4) * -0.2, np.arange(4) * 0.3
    ).wxyz
    positions = np.arange(12).reshape(4, 3) * 0.2
    for helper in (batch, reference):
        helper.update_cfg(cfg)
        helper.update_base_poses(batched_wxyzs=wxyzs, batched_positions=positions)
    before = [
        (h.batched_wxyzs.copy(), h.batched_positions.copy()) for h in batch._meshes
    ]
    before_transforms = batch._link_transforms.copy()
    cfg[indices] += [0.13, 0.025]
    wxyzs[indices] = tf.SO3.from_z_radians(np.arange(len(indices)) * 0.17 + 0.11).wxyz
    positions[indices] += [0.7, -0.2, 0.1]
    selected_cfg = cfg[indices].copy()
    selected_w = wxyzs[indices].copy() * 2  # Normalization must not mutate input.
    selected_p = positions[indices].copy()
    saved_indices = indices.copy()
    with patch.object(batch._urdf, "update_cfg", wraps=batch._urdf.update_cfg) as fk:
        if bases_first:
            batch.update_base_poses(
                batched_wxyzs=selected_w,
                batched_positions=selected_p,
                robot_indices=indices,
            )
            assert fk.call_count == 0
        batch.update_cfg(selected_cfg, robot_indices=indices)
        assert fk.call_count == len(indices)
        if not bases_first:
            batch.update_base_poses(
                batched_wxyzs=selected_w,
                batched_positions=selected_p,
                robot_indices=indices,
            )
        assert fk.call_count == len(indices)
    reference.update_cfg(cfg)
    reference.update_base_poses(batched_wxyzs=wxyzs, batched_positions=positions)
    np.testing.assert_array_equal(indices, saved_indices)
    np.testing.assert_array_equal(selected_cfg, cfg[indices])
    np.testing.assert_array_equal(selected_w, wxyzs[indices] * 2)
    np.testing.assert_array_equal(selected_p, positions[indices])
    other = np.setdiff1d(np.arange(4), indices)
    np.testing.assert_array_equal(
        batch._link_transforms[other], before_transforms[other]
    )
    for actual, expected, (old_w, old_p) in zip(
        batch._meshes, reference._meshes, before
    ):
        np.testing.assert_array_equal(actual.batched_wxyzs[other], old_w[other])
        np.testing.assert_array_equal(actual.batched_positions[other], old_p[other])
        np.testing.assert_allclose(actual.batched_wxyzs, expected.batched_wxyzs)
        np.testing.assert_allclose(actual.batched_positions, expected.batched_positions)
    # Selected inputs and indices must not alias internal cache after the call.
    selected_cfg[:] = 0
    selected_w[:] = 0
    selected_p[:] = 0
    indices[:] = 0
    np.testing.assert_allclose(batch._base_positions, positions)
    np.testing.assert_allclose(batch._link_transforms, reference._link_transforms)
    # Subsequent full updates remain valid after partial updates.
    batch.update_cfg(cfg + [0.05, 0.01])
    reference.update_cfg(cfg + [0.05, 0.01])
    for actual, expected in zip(batch._meshes, reference._meshes):
        np.testing.assert_array_equal(
            actual.batched_positions, expected.batched_positions
        )


@pytest.mark.parametrize(
    "indices",
    [
        np.array([True]),
        np.array([0.0]),
        np.array([[0]]),
        np.array(0),
        np.array([0, 0]),
        np.array([-1]),
        np.array([3]),
        np.array([2**64 - 1], dtype=np.uint64),
        np.array([0], dtype=object),
    ],
)
def test_invalid_indices_rejected_before_changes(server, indices):
    batch = BatchedViserUrdf(server, URDF_PATH, 3)
    start = server._websock_server._broadcast_buffer.message_counter
    transforms = batch._link_transforms.copy()
    bases = batch._base_positions.copy(), batch._base_wxyzs.copy()
    with patch.object(
        batch._urdf, "update_cfg", side_effect=AssertionError("unexpected FK")
    ):
        with pytest.raises(ValueError, match="robot_indices"):
            batch.update_cfg(np.zeros((1, 2)), robot_indices=indices)
        with pytest.raises(ValueError, match="robot_indices"):
            batch.update_base_poses(
                batched_wxyzs=np.array([[1, 0, 0, 0]]),
                batched_positions=np.zeros((1, 3)),
                robot_indices=indices,
            )
    assert server._websock_server._broadcast_buffer.message_counter == start
    np.testing.assert_array_equal(batch._link_transforms, transforms)
    np.testing.assert_array_equal(batch._base_positions, bases[0])
    np.testing.assert_array_equal(batch._base_wxyzs, bases[1])


def test_empty_and_repeated_indexed_updates_and_lifecycle(server):
    batch = BatchedViserUrdf(server, URDF_PATH, 3)
    empty = np.array([], dtype=np.int64)
    start = server._websock_server._broadcast_buffer.message_counter
    with patch.object(
        batch._urdf, "update_cfg", side_effect=AssertionError("unexpected FK")
    ):
        batch.update_cfg(np.zeros((0, 2)), robot_indices=empty)
        batch.update_base_poses(
            batched_wxyzs=np.zeros((0, 4)),
            batched_positions=np.zeros((0, 3)),
            robot_indices=empty,
        )
        with pytest.raises(ValueError, match="shape"):
            batch.update_cfg(np.zeros((1, 2)), robot_indices=empty)
        with pytest.raises(ValueError, match="shape"):
            batch.update_base_poses(
                batched_wxyzs=np.zeros((0, 4)),
                batched_positions=np.zeros((1, 3)),
                robot_indices=empty,
            )
    assert server._websock_server._broadcast_buffer.message_counter == start
    cfg = np.array([[0.23, 0.12]])
    indices = np.array([2], dtype=np.uint64)
    batch.update_cfg(cfg, robot_indices=indices)
    batch.update_base_poses(
        batched_wxyzs=np.array([[1, 0, 0, 0]]),
        batched_positions=np.array([[1, 2, 3]]),
        robot_indices=indices,
    )
    start = server._websock_server._broadcast_buffer.message_counter
    for _ in range(3):
        batch.update_cfg(cfg, robot_indices=indices)
        batch.update_base_poses(
            batched_wxyzs=np.array([[1, 0, 0, 0]]),
            batched_positions=np.array([[1, 2, 3]]),
            robot_indices=indices,
        )
    assert server._websock_server._broadcast_buffer.message_counter == start
    # Replacement invalidates even empty indexed calls from the stale helper.
    replacement = BatchedViserUrdf(server, URDF_PATH, 3)
    for helper in (batch, replacement):
        if helper is replacement:
            helper.remove()
        with pytest.raises(RuntimeError, match="removed or replaced"):
            helper.update_cfg(np.zeros((0, 2)), robot_indices=empty)
        with pytest.raises(RuntimeError, match="removed or replaced"):
            helper.update_base_poses(
                batched_wxyzs=np.zeros((0, 4)),
                batched_positions=np.zeros((0, 3)),
                robot_indices=empty,
            )


@pytest.mark.parametrize(
    "failure", ["shape", "nan", "overflow", "base_nan", "base_zero", "base_overflow"]
)
def test_invalid_indexed_data_preserves_all_caches_and_display(server, failure):
    batch = BatchedViserUrdf(server, URDF_PATH, 3)
    indices = np.array([2, 0])
    transforms = batch._link_transforms.copy()
    bases = batch._base_positions.copy(), batch._base_wxyzs.copy()
    before = [
        (h.batched_wxyzs.copy(), h.batched_positions.copy()) for h in batch._meshes
    ]
    start = server._websock_server._broadcast_buffer.message_counter
    with pytest.raises(ValueError):
        if failure in ("shape", "nan", "overflow"):
            cfg = np.zeros((2, 2)) if failure != "shape" else np.zeros((3, 2))
            if failure == "nan":
                cfg[1, 0] = np.nan
            elif failure == "overflow":
                cfg[1, 1] = 1e100
            batch.update_cfg(cfg, robot_indices=indices)
        else:
            wxyzs = np.tile([1.0, 0, 0, 0], (2, 1))
            positions = np.zeros((2, 3))
            if failure == "base_nan":
                positions[1, 2] = np.nan
            elif failure == "base_zero":
                wxyzs[1] = 0
            else:
                positions[1, 2] = 1e100
            batch.update_base_poses(
                batched_wxyzs=wxyzs, batched_positions=positions, robot_indices=indices
            )
    assert server._websock_server._broadcast_buffer.message_counter == start
    np.testing.assert_array_equal(batch._link_transforms, transforms)
    np.testing.assert_array_equal(batch._base_positions, bases[0])
    np.testing.assert_array_equal(batch._base_wxyzs, bases[1])
    for handle, (w, p) in zip(batch._meshes, before):
        np.testing.assert_array_equal(handle.batched_wxyzs, w)
        np.testing.assert_array_equal(handle.batched_positions, p)
    # Failed FK may mutate private yourdfpy state; the next update must recover.
    batch.update_cfg(np.array([[0.2, 0.1]]), robot_indices=np.array([1]))
    np.testing.assert_array_equal(batch._link_transforms[[0, 2]], transforms[[0, 2]])


def test_concurrent_disjoint_indexed_calls_preserve_all_robot_states(server):
    from concurrent.futures import ThreadPoolExecutor

    batch = BatchedViserUrdf(server, URDF_PATH, 4, root_node_name="/concurrent")
    reference = BatchedViserUrdf(server, URDF_PATH, 4, root_node_name="/reference")

    def update_row(row):
        for step in range(20):
            batch.update_cfg(
                np.array([[0.01 * (step + row), 0.002 * step]]),
                robot_indices=np.array([row]),
            )
            batch.update_base_poses(
                batched_wxyzs=tf.SO3.from_z_radians(np.array([0.01 * step])).wxyz,
                batched_positions=np.array([[row, 0.01 * step, 0.0]]),
                robot_indices=np.array([row]),
            )

    with ThreadPoolExecutor(max_workers=2) as executor:
        list(executor.map(update_row, [1, 3]))
    cfg = np.zeros((4, 2))
    wxyzs = np.tile([1.0, 0, 0, 0], (4, 1))
    positions = np.zeros((4, 3))
    for row in [1, 3]:
        cfg[row] = [0.01 * (19 + row), 0.002 * 19]
        wxyzs[row] = tf.SO3.from_z_radians(0.19).wxyz
        positions[row] = [row, 0.19, 0]
    reference.update_cfg(cfg)
    reference.update_base_poses(batched_wxyzs=wxyzs, batched_positions=positions)
    for actual, expected in zip(batch._meshes, reference._meshes):
        np.testing.assert_array_equal(actual.batched_wxyzs, expected.batched_wxyzs)
        np.testing.assert_array_equal(
            actual.batched_positions, expected.batched_positions
        )


@pytest.mark.parametrize("client_scoped", [False, True])
def test_indexed_edits_use_existing_full_array_protocol(server, client_scoped):
    """Indexed FK must remain compatible with the unmodified dense wire API."""
    from viser import _messages

    target = make_synthetic_client(server, 102) if client_scoped else server
    connection = target._websock_connection if client_scoped else server._websock_server
    batch = BatchedViserUrdf(target, URDF_PATH, 4, root_node_name="/dense_wire")
    initial = {
        handle.name: (handle.batched_wxyzs.copy(), handle.batched_positions.copy())
        for handle in batch._meshes
    }
    with patch.object(
        connection, "queue_message", wraps=connection.queue_message
    ) as sent:
        batch.update_cfg(
            np.array([[0.7, 0.12], [-0.4, 0.2]]), robot_indices=np.array([3, 1])
        )
        batch.update_base_poses(
            batched_wxyzs=tf.SO3.from_z_radians(np.array([0.4, -0.3])).wxyz,
            batched_positions=np.array([[1.0, 2.0, 0.3], [-1.0, 0.0, 0.5]]),
            robot_indices=np.array([3, 1]),
        )
    messages = [call.args[0] for call in sent.call_args_list]
    assert messages
    expected_names = set(initial)
    fields = set()
    for message in messages:
        assert isinstance(message, _messages.SceneNodeUpdateMessage)
        assert message.name in expected_names
        assert set(message.updates) <= {"batched_wxyzs", "batched_positions"}
        for key, value in message.updates.items():
            fields.add(key)
            assert value.shape == (4, 4 if key == "batched_wxyzs" else 3)
            assert value.dtype == np.float32
            old = initial[message.name][0 if key == "batched_wxyzs" else 1]
            np.testing.assert_array_equal(value[[0, 2]], old[[0, 2]])
    assert fields == {"batched_wxyzs", "batched_positions"}


@pytest.mark.parametrize(
    "field", ["configurations", "batched_wxyzs", "batched_positions"]
)
@pytest.mark.parametrize("imaginary", [1.0, np.nan, np.inf])
@pytest.mark.parametrize("indexed", [False, True])
@pytest.mark.parametrize("storage", ["complex", "object"])
def test_complex_pose_inputs_rejected_without_state_changes(
    server, field, imaginary, indexed, storage
):
    """Dropping imaginary components can hide non-finite input and alter poses."""
    batch = BatchedViserUrdf(server, URDF_PATH, 2)
    count = 1 if indexed else 2
    selector = {"robot_indices": np.array([1])} if indexed else {}
    args = {
        "configurations": np.tile([0.3, 0.12], (count, 1)),
        "batched_wxyzs": np.tile([1.0, 0, 0, 0], (count, 1)),
        "batched_positions": np.full((count, 3), 0.5),
    }
    value = args[field].astype(np.complex128)
    value.imag.flat[0] = imaginary
    if storage == "object":
        complex_values = value
        value = np.empty(complex_values.shape, dtype=object)
        for index in np.ndindex(value.shape):
            value[index] = complex_values[index]
        assert isinstance(value.flat[0], np.complexfloating)
    args[field] = value
    transforms = batch._link_transforms.copy()
    bases = batch._base_wxyzs.copy(), batch._base_positions.copy()
    configuration = batch._urdf.cfg.copy()
    before = [
        (handle.batched_wxyzs.copy(), handle.batched_positions.copy())
        for handle in batch._meshes
    ]
    buffer = server._websock_server._broadcast_buffer
    counter = buffer.message_counter
    with pytest.raises(ValueError, match="real array"):
        if field == "configurations":
            batch.update_cfg(args[field], **selector)
        else:
            batch.update_base_poses(
                batched_wxyzs=args["batched_wxyzs"],
                batched_positions=args["batched_positions"],
                **selector,
            )
    assert buffer.message_counter == counter
    np.testing.assert_array_equal(batch._urdf.cfg, configuration)
    np.testing.assert_array_equal(batch._link_transforms, transforms)
    np.testing.assert_array_equal(batch._base_wxyzs, bases[0])
    np.testing.assert_array_equal(batch._base_positions, bases[1])
    for handle, (wxyzs, positions) in zip(batch._meshes, before):
        np.testing.assert_array_equal(handle.batched_wxyzs, wxyzs)
        np.testing.assert_array_equal(handle.batched_positions, positions)


def test_real_numeric_object_arrays_remain_compatible(server):
    """Reject complex object scalars without rejecting existing real inputs."""
    batch = BatchedViserUrdf(server, URDF_PATH, 2)
    cfg = np.array([[np.float32(0.3), np.float64(0.12)], [-0.4, 0.2]], dtype=object)
    wxyzs = np.array([[1, 0, 0, 0], [1, 0, 0, 1]], dtype=object)
    positions = np.array([[1, 2, 3], [-1.0, np.float32(0.5), 0]], dtype=object)
    batch.update_cfg(cfg)
    batch.update_base_poses(batched_wxyzs=wxyzs, batched_positions=positions)
    np.testing.assert_array_equal(batch._base_positions, positions.astype(float))
    np.testing.assert_allclose(
        batch._base_wxyzs, [[1, 0, 0, 0], [1 / np.sqrt(2), 0, 0, 1 / np.sqrt(2)]]
    )
    reference = yourdfpy.URDF.load(URDF_PATH)
    for row, configuration in enumerate(cfg.astype(float)):
        reference.update_cfg(configuration)
        for link_index, link in enumerate(batch._link_names):
            np.testing.assert_allclose(
                batch._link_transforms[row, link_index], reference.get_transform(link)
            )
    cfg[:] = 0
    wxyzs[:] = 0
    positions[:] = 0
    np.testing.assert_array_equal(batch._base_positions, [[1, 2, 3], [-1, 0.5, 0]])
