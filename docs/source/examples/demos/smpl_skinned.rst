SMPL skinned mesh
=================

Visualize SMPL human body models using skinned mesh deformation. For
visualizing human motion sequences, updating bone transformations should be
much faster than updating the entire mesh.

See here for download instructions:
    https://github.com/vchoutas/smplx?tab=readme-ov-file#downloading-the-model

**Features:**

* SMPL skinned mesh with real-time deformation
* Interactive pose parameter controls

.. note::
    This example requires external assets. To download them, run:

    .. code-block:: bash

        git clone https://github.com/viser-project/viser.git
        cd viser/examples
        ./assets/download_assets.sh
        python 04_demos/04_smpl_skinned.py  # With viser installed.

**Source:** ``examples/04_demos/04_smpl_skinned.py``

.. figure:: ../../_static/examples/04_demos_04_smpl_skinned.png
   :width: 100%
   :alt: SMPL skinned mesh

Code
----

.. code-block:: python
   :linenos:

   # mypy: disable-error-code="assignment"
   #
   # Asymmetric properties are supported in Pyright, but not yet in mypy.
   # - https://github.com/python/mypy/issues/3004
   # - https://github.com/python/mypy/pull/11643
   
   from __future__ import annotations
   
   import time
   from dataclasses import dataclass
   from pathlib import Path
   from typing import List, Tuple
   
   import numpy as np
   import tyro
   
   import viser
   import viser.transforms as tf
   
   
   @dataclass(frozen=True)
   class SmplFkOutputs:
       T_world_joint: np.ndarray  # (num_joints, 4, 4)
       T_parent_joint: np.ndarray  # (num_joints, 4, 4)
   
   
   class SmplHelper:
   
       def __init__(self, model_path: Path) -> None:
           assert model_path.suffix.lower() == ".npz", "Model should be an .npz file!"
           body_dict = dict(**np.load(model_path, allow_pickle=True))
   
           self.J_regressor = body_dict["J_regressor"]
           self.weights = body_dict["weights"]
           self.v_template = body_dict["v_template"]
           self.posedirs = body_dict["posedirs"]
           self.shapedirs = body_dict["shapedirs"]
           self.faces = body_dict["f"]
   
           self.num_joints: int = self.weights.shape[-1]
           self.num_betas: int = self.shapedirs.shape[-1]
           self.parent_idx: np.ndarray = body_dict["kintree_table"][0]
   
       def get_tpose(self, betas: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
           # Get shaped vertices + joint positions, when all local poses are identity.
           v_tpose = self.v_template + np.einsum("vxb,b->vx", self.shapedirs, betas)
           j_tpose = np.einsum("jv,vx->jx", self.J_regressor, v_tpose)
           return v_tpose, j_tpose
   
       def get_outputs(
           self, betas: np.ndarray, joint_rotmats: np.ndarray
       ) -> SmplFkOutputs:
           # Get shaped vertices + joint positions, when all local poses are identity.
           v_tpose = self.v_template + np.einsum("vxb,b->vx", self.shapedirs, betas)
           j_tpose = np.einsum("jv,vx->jx", self.J_regressor, v_tpose)
   
           # Local SE(3) transforms.
           T_parent_joint = np.zeros((self.num_joints, 4, 4)) + np.eye(4)
           T_parent_joint[:, :3, :3] = joint_rotmats
           T_parent_joint[0, :3, 3] = j_tpose[0]
           T_parent_joint[1:, :3, 3] = j_tpose[1:] - j_tpose[self.parent_idx[1:]]
   
           # Forward kinematics.
           T_world_joint = T_parent_joint.copy()
           for i in range(1, self.num_joints):
               T_world_joint[i] = T_world_joint[self.parent_idx[i]] @ T_parent_joint[i]
   
           return SmplFkOutputs(T_world_joint, T_parent_joint)
   
   
   def main(
       model_path: Path = Path(__file__).parent / "../assets/SMPLH_NEUTRAL.npz",
   ) -> None:
       server = viser.ViserServer()
       server.scene.set_up_direction("+y")
   
       # Main loop. We'll read pose/shape from the GUI elements, compute the mesh,
       # and then send the updated mesh in a loop.
       model = SmplHelper(model_path)
       gui_elements = make_gui_elements(
           server,
           num_betas=model.num_betas,
           num_joints=model.num_joints,
           parent_idx=model.parent_idx,
       )
       v_tpose, j_tpose = model.get_tpose(np.zeros((model.num_betas,)))
       mesh_handle = server.scene.add_mesh_skinned(
           "/human",
           v_tpose,
           model.faces,
           bone_wxyzs=tf.SO3.identity(batch_axes=(model.num_joints,)).wxyz,
           bone_positions=j_tpose,
           skin_weights=model.weights,
           wireframe=gui_elements.gui_wireframe.value,
           color=gui_elements.gui_rgb.value,
       )
       server.scene.add_grid("/grid", position=(0.0, -1.3, 0.0), plane="xz")
   
       while True:
           # Do nothing if no change.
           time.sleep(0.02)
           if not gui_elements.changed:
               continue
   
           # Shapes changed: update vertices / joint positions.
           if gui_elements.betas_changed:
               v_tpose, j_tpose = model.get_tpose(
                   np.array([gui_beta.value for gui_beta in gui_elements.gui_betas])
               )
               mesh_handle.vertices = v_tpose
               mesh_handle.bone_positions = j_tpose
   
           mesh_handle.color = gui_elements.gui_rgb.value
           gui_elements.changed = False
           gui_elements.betas_changed = False
   
           # Render as wireframe?
           mesh_handle.wireframe = gui_elements.gui_wireframe.value
   
           # Compute SMPL outputs.
           smpl_outputs = model.get_outputs(
               betas=np.array([x.value for x in gui_elements.gui_betas]),
               joint_rotmats=np.stack(
                   [
                       tf.SO3.exp(np.array(x.value)).as_matrix()
                       for x in gui_elements.gui_joints
                   ],
                   axis=0,
               ),
           )
   
           # Match transform control gizmos to joint positions.
           for i, control in enumerate(gui_elements.transform_controls):
               control.position = smpl_outputs.T_parent_joint[i, :3, 3]
               mesh_handle.bones[i].wxyz = tf.SO3.from_matrix(
                   smpl_outputs.T_world_joint[i, :3, :3]
               ).wxyz
               mesh_handle.bones[i].position = smpl_outputs.T_world_joint[i, :3, 3]
   
   
   @dataclass
   class GuiElements:
   
       gui_rgb: viser.GuiInputHandle[Tuple[int, int, int]]
       gui_wireframe: viser.GuiInputHandle[bool]
       gui_betas: List[viser.GuiInputHandle[float]]
       gui_joints: List[viser.GuiInputHandle[Tuple[float, float, float]]]
       transform_controls: List[viser.TransformControlsHandle]
   
       changed: bool
   
       betas_changed: bool
   
   
   def make_gui_elements(
       server: viser.ViserServer,
       num_betas: int,
       num_joints: int,
       parent_idx: np.ndarray,
   ) -> GuiElements:
   
       tab_group = server.gui.add_tab_group()
   
       def set_changed(_) -> None:
           out.changed = True  # out is defined later!
   
       def set_betas_changed(_) -> None:
           out.betas_changed = True
           out.changed = True
   
       # GUI elements: mesh settings + visibility.
       with tab_group.add_tab("View", viser.Icon.VIEWFINDER):
           gui_rgb = server.gui.add_rgb("Color", initial_value=(90, 200, 255))
           gui_wireframe = server.gui.add_checkbox("Wireframe", initial_value=False)
           gui_show_controls = server.gui.add_checkbox("Handles", initial_value=True)
           gui_control_size = server.gui.add_slider(
               "Handle size", min=0.0, max=10.0, step=0.01, initial_value=1.0
           )
   
           gui_rgb.on_update(set_changed)
           gui_wireframe.on_update(set_changed)
   
           @gui_show_controls.on_update
           def _(_):
               for control in transform_controls:
                   control.visible = gui_show_controls.value
   
           @gui_control_size.on_update
           def _(_):
               for control in transform_controls:
                   prefixed_joint_name = control.name
                   control.scale = (
                       0.2
                       * (0.75 ** prefixed_joint_name.count("/"))
                       * gui_control_size.value
                   )
   
       # GUI elements: shape parameters.
       with tab_group.add_tab("Shape", viser.Icon.BOX):
           gui_reset_shape = server.gui.add_button("Reset Shape")
           gui_random_shape = server.gui.add_button("Random Shape")
   
           @gui_reset_shape.on_click
           def _(_):
               for beta in gui_betas:
                   beta.value = 0.0
   
           @gui_random_shape.on_click
           def _(_):
               for beta in gui_betas:
                   beta.value = np.random.normal(loc=0.0, scale=1.0)
   
           gui_betas = []
           for i in range(num_betas):
               beta = server.gui.add_slider(
                   f"beta{i}", min=-5.0, max=5.0, step=0.01, initial_value=0.0
               )
               gui_betas.append(beta)
               beta.on_update(set_betas_changed)
   
       # GUI elements: joint angles.
       with tab_group.add_tab("Joints", viser.Icon.ANGLE):
           gui_reset_joints = server.gui.add_button("Reset Joints")
           gui_random_joints = server.gui.add_button("Random Joints")
   
           @gui_reset_joints.on_click
           def _(_):
               for joint in gui_joints:
                   joint.value = (0.0, 0.0, 0.0)
   
           @gui_random_joints.on_click
           def _(_):
               rng = np.random.default_rng()
               for joint in gui_joints:
                   joint.value = tf.SO3.sample_uniform(rng).log()
   
           gui_joints: List[viser.GuiInputHandle[Tuple[float, float, float]]] = []
           for i in range(num_joints):
               gui_joint = server.gui.add_vector3(
                   label=f"Joint {i}",
                   initial_value=(0.0, 0.0, 0.0),
                   step=0.05,
               )
               gui_joints.append(gui_joint)
   
               def set_callback_in_closure(i: int) -> None:
                   @gui_joint.on_update
                   def _(_):
                       transform_controls[i].wxyz = tf.SO3.exp(
                           np.array(gui_joints[i].value)
                       ).wxyz
                       out.changed = True
   
               set_callback_in_closure(i)
   
       # Transform control gizmos on joints.
       transform_controls: List[viser.TransformControlsHandle] = []
       prefixed_joint_names = []  # Joint names, but prefixed with parents.
       for i in range(num_joints):
           prefixed_joint_name = f"joint_{i}"
           if i > 0:
               prefixed_joint_name = (
                   prefixed_joint_names[parent_idx[i]] + "/" + prefixed_joint_name
               )
           prefixed_joint_names.append(prefixed_joint_name)
           controls = server.scene.add_transform_controls(
               f"/smpl/{prefixed_joint_name}",
               depth_test=False,
               scale=0.2 * (0.75 ** prefixed_joint_name.count("/")),
               disable_axes=True,
               disable_sliders=True,
               visible=gui_show_controls.value,
           )
           transform_controls.append(controls)
   
           def set_callback_in_closure(i: int) -> None:
               @controls.on_update
               def _(_) -> None:
                   axisangle = tf.SO3(transform_controls[i].wxyz).log()
                   gui_joints[i].value = (axisangle[0], axisangle[1], axisangle[2])
   
           set_callback_in_closure(i)
   
       out = GuiElements(
           gui_rgb,
           gui_wireframe,
           gui_betas,
           gui_joints,
           transform_controls=transform_controls,
           changed=True,
           betas_changed=False,
       )
       return out
   
   
   if __name__ == "__main__":
       tyro.cli(main, description=__doc__)
   
