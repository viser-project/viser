# I2RT YAM linear gripper — STEP files

STEP (AP214) solid models of the I2RT [linear gripper](https://i2rt.com/products/yam-gripper-1)
("Linear 4310") for the YAM arm.

| File | Contents |
| --- | --- |
| `gripper.step` | Gripper body (motor + housing + linear rails), 1 solid |
| `tip_left.step` | Left finger + carriage, 1 solid |
| `tip_right.step` | Right finger + carriage, 1 solid |
| `linear_gripper_assembly.step` | All three parts posed per the MuJoCo model at joint position 0 (closed), origin at the gripper mount frame, tool axis pointing −z |

Units are **millimeters**.

## Provenance and caveats

I2RT does not publish B-rep CAD for this gripper. These files were generated
from the STL meshes in the MIT-licensed
[i2rt-robotics/i2rt](https://github.com/i2rt-robotics/i2rt) repository
(commit `1276f63d640eb45c226efd3dc08430b810372e94`, path
`i2rt/robot_models/gripper/linear_4310/assets/`), which are themselves
decimated visual meshes (8,000 triangles per part).

Consequences:

- **Curved surfaces are faceted.** Planar regions were merged into clean
  planar faces (`ShapeUpgrade_UnifySameDomain`), but cylinders/fillets remain
  polygonal. Fine for mounting fixtures, clearance checks, and visualization;
  not a parametric model.
- Solids are watertight and volume-exact against the source meshes
  (relative error < 1e-8), including the two internal cavities in each
  finger, which are represented as true voids.
- Individual part files keep their original STL mesh frames; use the
  assembly file for correctly posed geometry.

## Regenerating

```bash
pip install trimesh scipy cadquery-ocp
git clone https://github.com/i2rt-robotics/i2rt.git
python stl_to_step.py ./i2rt
```

`stl_to_step.py` sews each STL into a closed shell, converts it to a solid,
boolean-subtracts internal cavities, merges coplanar facets, and writes STEP.
It asserts volume parity with the source mesh at every stage.
