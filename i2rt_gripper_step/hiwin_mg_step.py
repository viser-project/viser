"""Parametric STEP models of HIWIN MG-series miniature linear guides.

Dimensions from the official HIWIN MG Series catalog (G99TE24-2410,
pp. 88-89). All units mm. Coordinate convention shared by rails and
carriages so they assemble directly:

- rail axis = +X, rail bottom face at z=0, centered in Y
- rail origin at one end (holes start at x=E)
- carriage origin at block center in X/Y; the block spans
  z in [H1, H], i.e. it sits at ride height on a rail at z=0

The ball raceway grooves/ridges are simplified circular arcs (the true
gothic-arch profile is proprietary); thread holes are modeled at nominal
diameter without helices. Good for fixtures, clearance checks, and
rendering; not for raceway analysis.
"""

from dataclasses import dataclass

from build123d import (
    Box,
    BuildPart,
    BuildSketch,
    Cylinder,
    Locations,
    Mode,
    Plane,
    Rectangle,
    export_step,
    extrude,
)


@dataclass(frozen=True)
class RailSpec:
    name: str
    WR: float  # rail width
    HR: float  # rail height
    D: float  # counterbore diameter
    h: float  # counterbore depth
    d: float  # through hole diameter
    P: float  # hole pitch
    E: float  # standard end offset (min)
    groove_z: float  # groove center height from rail bottom
    groove_r: float  # groove arc radius
    groove_depth: float  # groove depth into the side face


@dataclass(frozen=True)
class CarriageSpec:
    name: str
    rail: RailSpec
    H: float  # assembly height (rail bottom -> block top)
    H1: float  # clearance under block
    W: float  # block width
    B: float  # mounting holes across width
    C: float  # mounting holes along length
    L1: float  # steel body length
    L: float  # total length incl. end caps
    M: float  # thread nominal diameter
    thread_depth: float
    Gn: float = 1.2  # grease hole diameter (in end caps)


MGN7_RAIL = RailSpec(
    "MGN7R",
    WR=7,
    HR=4.8,
    D=4.2,
    h=2.3,
    d=2.4,
    P=15,
    E=5,
    groove_z=3.3,
    groove_r=0.75,
    groove_depth=0.45,
)
MGW7_RAIL = RailSpec(
    "MGW7R",
    WR=14,
    HR=5.2,
    D=6.0,
    h=3.2,
    d=3.5,
    P=30,
    E=10,
    groove_z=3.5,
    groove_r=0.9,
    groove_depth=0.55,
)

MGN7C = CarriageSpec(
    "MGN7C",
    MGN7_RAIL,
    H=8,
    H1=1.5,
    W=17,
    B=12,
    C=8,
    L1=13.5,
    L=22.5,
    M=2,
    thread_depth=2.5,
)
MGN7H = CarriageSpec(
    "MGN7H",
    MGN7_RAIL,
    H=8,
    H1=1.5,
    W=17,
    B=12,
    C=13,
    L1=21.8,
    L=30.8,
    M=2,
    thread_depth=2.5,
)
MGW7C = CarriageSpec(
    "MGW7C",
    MGW7_RAIL,
    H=9,
    H1=1.9,
    W=25,
    B=19,
    C=10,
    L1=21.0,
    L=31.2,
    M=3,
    thread_depth=3.0,
)
MGW7H = CarriageSpec(
    "MGW7H",
    MGW7_RAIL,
    H=9,
    H1=1.9,
    W=25,
    B=19,
    C=19,
    L1=30.8,
    L=41.0,
    M=3,
    thread_depth=3.0,
)

SLOT_SIDE_CLEARANCE = 0.3  # each side, block slot vs rail
SLOT_TOP_CLEARANCE = 0.3  # block slot ceiling vs rail top
CAP_INSET = 0.25  # end cap inset vs steel body (sides + top)


def hole_positions(rail: RailSpec, length: float) -> list[float]:
    """Symmetric hole layout: max hole count with end offsets >= E."""
    n = int((length - 2 * rail.E) // rail.P) + 1
    e = (length - (n - 1) * rail.P) / 2
    return [e + i * rail.P for i in range(n)]


def make_rail(rail: RailSpec, length: float):
    with BuildPart() as part:
        with BuildSketch(Plane.XY):
            with Locations((length / 2, 0)):
                Rectangle(length, rail.WR)
        extrude(amount=rail.HR)
        # Raceway grooves: cylinders along X buried in each side face.
        for side in (-1, 1):
            y_axis = side * (rail.WR / 2 + rail.groove_r - rail.groove_depth)
            with BuildPart(mode=Mode.SUBTRACT):
                with Locations((length / 2, y_axis, rail.groove_z)):
                    Cylinder(rail.groove_r, length, rotation=(0, 90, 0))
        # Counterbored mounting holes.
        for x in hole_positions(rail, length):
            with BuildPart(mode=Mode.SUBTRACT):
                with Locations((x, 0, rail.HR / 2)):
                    Cylinder(rail.d / 2, rail.HR)
                with Locations((x, 0, rail.HR - rail.h / 2)):
                    Cylinder(rail.D / 2, rail.h)
    return part.part


def make_carriage(spec: CarriageSpec):
    rail = spec.rail
    body_top = spec.H
    slot_half = rail.WR / 2 + SLOT_SIDE_CLEARANCE
    slot_top = rail.HR + SLOT_TOP_CLEARANCE
    cap_len = (spec.L - spec.L1) / 2

    with BuildPart() as part:
        # Steel body.
        with BuildSketch(Plane.XY.offset(spec.H1)):
            Rectangle(spec.L1, spec.W)
        extrude(amount=body_top - spec.H1)
        # End caps (slightly inset on sides and top).
        for side in (-1, 1):
            xc = side * (spec.L1 / 2 + cap_len / 2)
            with BuildSketch(Plane.XY.offset(spec.H1)):
                with Locations((xc, 0)):
                    Rectangle(cap_len, spec.W - 2 * CAP_INSET)
            extrude(amount=body_top - CAP_INSET - spec.H1)
        # Rail slot.
        with BuildPart(mode=Mode.SUBTRACT):
            with Locations((0, 0, (spec.H1 + slot_top) / 2)):
                Box(spec.L + 2, 2 * slot_half, slot_top - spec.H1)
        # Raceway ridges reaching into the rail grooves. Centered on the
        # slot walls, so the outer half merges into the block material.
        ridge_r = rail.groove_depth + 0.2
        for side in (-1, 1):
            with BuildPart(mode=Mode.ADD):
                with Locations((0, side * slot_half, rail.groove_z)):
                    Cylinder(ridge_r, spec.L, rotation=(0, 90, 0))
        # Mounting thread holes (nominal diameter, no helix).
        for sx in (-1, 1):
            for sy in (-1, 1):
                with BuildPart(mode=Mode.SUBTRACT):
                    with Locations(
                        (
                            sx * spec.C / 2,
                            sy * spec.B / 2,
                            body_top - spec.thread_depth / 2,
                        )
                    ):
                        Cylinder(spec.M / 2, spec.thread_depth)
        # Grease holes in end caps.
        gz = (slot_top + body_top) / 2
        for side in (-1, 1):
            with BuildPart(mode=Mode.SUBTRACT):
                with Locations((side * (spec.L / 2 - 1.0), 0, gz)):
                    Cylinder(spec.Gn / 2, 2.5, rotation=(0, 90, 0))
    return part.part


def main() -> None:
    rails = [(MGN7_RAIL, 100.0), (MGW7_RAIL, 100.0)]
    for rail, length in rails:
        p = make_rail(rail, length)
        assert p.is_valid
        name = f"{rail.name}_{int(length)}mm"
        export_step(p, f"{name}.step")
        bb = p.bounding_box()
        print(
            f"{name}: bbox {bb.size.X:.2f} x {bb.size.Y:.2f} x {bb.size.Z:.2f}, "
            f"volume {p.volume:.1f} mm^3, holes at {hole_positions(rail, length)}"
        )

    for spec in [MGN7C, MGN7H, MGW7C, MGW7H]:
        p = make_carriage(spec)
        assert p.is_valid
        export_step(p, f"{spec.name}.step")
        bb = p.bounding_box()
        print(
            f"{spec.name}: bbox {bb.size.X:.2f} x {bb.size.Y:.2f} x {bb.size.Z:.2f}, "
            f"volume {p.volume:.1f} mm^3"
        )


if __name__ == "__main__":
    main()
