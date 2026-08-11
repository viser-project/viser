"""Convert I2RT linear_4310 gripper STL meshes to STEP solids.

Each STL triangle becomes a planar face; faces are sewn into closed
shells, upgraded to solids, and coplanar facets are merged with
ShapeUpgrade_UnifySameDomain. Output is in millimeters.
"""

import sys

import numpy as np
import trimesh
from OCP.BRep import BRep_Builder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_MakeFace,
    BRepBuilderAPI_MakePolygon,
    BRepBuilderAPI_MakeSolid,
    BRepBuilderAPI_Sewing,
    BRepBuilderAPI_Transform,
)
from OCP.BRepGProp import BRepGProp
from OCP.gp import gp_Pnt, gp_Trsf
from OCP.GProp import GProp_GProps
from OCP.ShapeFix import ShapeFix_Solid
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
from OCP.TopAbs import TopAbs_SHELL
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Shape

# Path to the linear_4310 assets inside a clone of
# https://github.com/i2rt-robotics/i2rt (pass the clone root as argv[1]).
MESH_DIR = (
    sys.argv[1] if len(sys.argv) > 1 else "i2rt"
) + "/i2rt/robot_models/gripper/linear_4310/assets"
SCALE = 1000.0  # meters -> millimeters


def mesh_component_to_solid(vertices: np.ndarray, faces: np.ndarray) -> TopoDS_Shape:
    """Sew one connected watertight triangle mesh into a solid."""
    sewing = BRepBuilderAPI_Sewing(1e-6)
    pnts = [gp_Pnt(*v) for v in vertices]
    for tri in faces:
        poly = BRepBuilderAPI_MakePolygon(
            pnts[tri[0]], pnts[tri[1]], pnts[tri[2]], True
        )
        face = BRepBuilderAPI_MakeFace(poly.Wire(), True)
        if face.IsDone():
            sewing.Add(face.Face())
    sewing.Perform()
    sewn = sewing.SewedShape()

    exp = TopExp_Explorer(sewn, TopAbs_SHELL)
    solid_maker = BRepBuilderAPI_MakeSolid()
    n_shells = 0
    while exp.More():
        solid_maker.Add(TopoDS.Shell_s(exp.Current()))
        n_shells += 1
        exp.Next()
    assert n_shells == 1, f"expected 1 shell, got {n_shells}"
    solid = solid_maker.Solid()

    # Fix orientation so material is inside.
    fixer = ShapeFix_Solid(solid)
    fixer.Perform()
    solid = fixer.Solid()

    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(solid, props)
    assert props.Mass() > 0, f"negative volume {props.Mass()}"

    # Merge coplanar facets into single planar faces.
    unify = ShapeUpgrade_UnifySameDomain(solid, True, True, False)
    unify.SetLinearTolerance(1e-4)
    unify.SetAngularTolerance(1e-6)
    unify.Build()
    return unify.Shape()


def load_part(name: str) -> TopoDS_Compound:
    """Load an STL, convert every connected component, return compound (mm).

    Components with negative signed volume are internal cavities; they are
    boolean-subtracted from the enclosing positive-volume solid.
    """
    m = trimesh.load(f"{MESH_DIR}/{name}.stl")
    m.merge_vertices()
    m.apply_scale(SCALE)
    total_volume = m.volume

    outers: list[tuple[TopoDS_Shape, trimesh.Trimesh]] = []
    cavities: list[trimesh.Trimesh] = []
    for comp in m.split(only_watertight=True):
        if comp.volume < 0:
            cavities.append(comp)
        else:
            solid = mesh_component_to_solid(
                np.asarray(comp.vertices), np.asarray(comp.faces)
            )
            outers.append((solid, comp))

    for cav in cavities:
        cav_solid = mesh_component_to_solid(
            np.asarray(cav.vertices), np.asarray(cav.faces)
        )
        # Find the outer solid whose bounds contain this cavity.
        for i, (solid, comp) in enumerate(outers):
            if (comp.bounds[0] <= cav.bounds[0]).all() and (
                comp.bounds[1] >= cav.bounds[1]
            ).all():
                cut = BRepAlgoAPI_Cut(solid, cav_solid)
                assert cut.IsDone(), "boolean cut failed"
                outers[i] = (cut.Shape(), comp)
                break
        else:
            raise AssertionError("cavity not contained in any outer solid")

    builder = BRep_Builder()
    compound = TopoDS_Compound()
    builder.MakeCompound(compound)
    step_volume = 0.0
    for solid, _ in outers:
        unify = ShapeUpgrade_UnifySameDomain(solid, True, True, False)
        unify.SetLinearTolerance(1e-4)
        unify.SetAngularTolerance(1e-6)
        unify.Build()
        solid = unify.Shape()
        props = GProp_GProps()
        BRepGProp.VolumeProperties_s(solid, props)
        step_volume += props.Mass()
        builder.Add(compound, solid)
    rel_err = abs(step_volume - total_volume) / total_volume
    print(
        f"{name}: mesh volume {total_volume:.1f} mm^3, "
        f"STEP volume {step_volume:.1f} mm^3, rel err {rel_err:.2e}"
    )
    assert rel_err < 1e-6, "volume mismatch after conversion"
    return compound


def write_step(shape: TopoDS_Shape, path: str) -> None:
    writer = STEPControl_Writer()
    writer.Transfer(shape, STEPControl_AsIs)
    status = writer.Write(path)
    assert status == 1, f"STEP write failed for {path}"  # IFSelect_RetDone


def mjcf_transform(pos, quat_wxyz) -> gp_Trsf:
    """Build a gp_Trsf from MJCF pos + wxyz quaternion (positions in m)."""
    w, x, y, z = quat_wxyz
    n = np.linalg.norm([w, x, y, z])
    w, x, y, z = w / n, x / n, y / n, z / n
    R = np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ]
    )
    t = np.asarray(pos) * SCALE
    trsf = gp_Trsf()
    trsf.SetValues(
        R[0, 0],
        R[0, 1],
        R[0, 2],
        t[0],
        R[1, 0],
        R[1, 1],
        R[1, 2],
        t[1],
        R[2, 0],
        R[2, 1],
        R[2, 2],
        t[2],
    )
    return trsf


def transformed(shape: TopoDS_Shape, trsf: gp_Trsf) -> TopoDS_Shape:
    return BRepBuilderAPI_Transform(shape, trsf, False).Shape()


def main() -> None:
    parts = {name: load_part(name) for name in ["gripper", "tip_left", "tip_right"]}

    for name, shape in parts.items():
        write_step(shape, f"{name}.step")

    # Assembly: place parts per linear_4310.xml at joint position q=0.
    # T_root_mesh = T_root_body * T_body_geom (gripper root body is identity).
    t_gripper = mjcf_transform([-0.014, -0.0463995, 0.0731], [1, 0, 0, 0])

    t_left = mjcf_transform(
        [-0.0238981, 0.0450619, -0.0545599], [0.499998, -0.5, -0.5, -0.500002]
    )
    t_left.Multiply(
        mjcf_transform(
            [0.129783, 0.00999321, -0.0914614], [0.499998, 0.5, 0.500002, 0.5]
        )
    )

    t_right = mjcf_transform(
        [0.0238981, -0.0450619, -0.0545599], [0.707105, 0.707108, 0, 0]
    )
    t_right.Multiply(
        mjcf_transform([-0.0379932, 0.129783, 0.00133753], [0.707105, -0.707108, 0, 0])
    )

    builder = BRep_Builder()
    assembly = TopoDS_Compound()
    builder.MakeCompound(assembly)
    builder.Add(assembly, transformed(parts["gripper"], t_gripper))
    builder.Add(assembly, transformed(parts["tip_left"], t_left))
    builder.Add(assembly, transformed(parts["tip_right"], t_right))
    write_step(assembly, "linear_gripper_assembly.step")
    print("done")


if __name__ == "__main__":
    main()
