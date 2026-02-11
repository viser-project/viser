SMPL human model
================

Visualize SMPL human body models with pose and shape parameter controls.

Requires a .npz model file. See here for download instructions:
    https://github.com/vchoutas/smplx?tab=readme-ov-file#downloading-the-model

**Features:**

* SMPL model loading and mesh generation
* Interactive pose parameter sliders
* Real-time body shape and pose updates
* 3D mesh visualization with :meth:`viser.SceneApi.add_mesh_simple`

.. note::
    This example requires external assets. To download them, run:

    .. code-block:: bash

        git clone https://github.com/viser-project/viser.git
        cd viser/examples
        ./assets/download_assets.sh
        python 04_demos/03_smpl_visualizer.py  # With viser installed.

**Source:** ``examples/04_demos/03_smpl_visualizer.py``

.. figure:: ../../_static/examples/04_demos_03_smpl_visualizer.png
   :width: 100%
   :alt: SMPL human model

Code
----

.. code-block:: python
   :linenos:

   from __future__ import annotations
   
   import time
   from dataclasses import dataclass
   from pathlib import Path
   
   import numpy as np
   import trimesh
   import tyro
   
   import viser
   import viser.transforms as tf
   
   
   @dataclass(frozen=True)
   class SmplOutputs:
       vertices: np.ndarray
       faces: np.ndarray
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
   
       def get_outputs(self, betas: np.ndarray, joint_rotmats: np.ndarray) -> SmplOutputs:
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
   
           # Linear blend skinning.
           pose_delta = (joint_rotmats[1:, ...] - np.eye(3)).flatten()
           v_blend = v_tpose + np.einsum("byn,n->by", self.posedirs, pose_delta)
           v_delta = np.ones((v_blend.shape[0], self.num_joints, 4))
           v_delta[:, :, :3] = v_blend[:, None, :] - j_tpose[None, :, :]
           v_posed = np.einsum(
               "jxy,vj,vjy->vx", T_world_joint[:, :3, :], self.weights, v_delta
           )
           return SmplOutputs(v_posed, self.faces, T_world_joint, T_parent_joint)
   
   
   def main(
       model_path: Path = Path(__file__).parent / "../assets/SMPLH_NEUTRAL.npz",
   ) -> None:
       server = viser.ViserServer()
       server.scene.set_up_direction("+y")
       server.scene.add_grid("/grid", position=(0.0, -1.3, 0.0), plane="xz")
   
       # Main loop. We'll read pose/shape from the GUI elements, compute the mesh,
       # and then send the updated mesh in a loop.
       model = SmplHelper(model_path)
       gui_elements = make_gui_elements(
           server,
           num_betas=model.num_betas,
           num_joints=model.num_joints,
           parent_idx=model.parent_idx,
       )
       body_handle = server.scene.add_mesh_simple(
           "/human",
           model.v_template,
           model.faces,
           wireframe=gui_elements.gui_wireframe.value,
           color=gui_elements.gui_rgb.value,
       )
   
       # Add a vertex selector to the mesh. This will allow us to click on
       # vertices to get indices.
       red_sphere = trimesh.creation.icosphere(radius=0.001, subdivisions=1)
       red_sphere.visual.vertex_colors = (255, 0, 0, 255)  # type: ignore
       vertex_selector = server.scene.add_batched_meshes_trimesh(
           "/selector",
           red_sphere,
           batched_positions=model.v_template,
           batched_wxyzs=((1.0, 0.0, 0.0, 0.0),) * model.v_template.shape[0],
       )
   
       @vertex_selector.on_click
       def _(event: viser.SceneNodePointerEvent) -> None:
           event.client.add_notification(
               f"Clicked on vertex {event.instance_index}",
               body="",
               auto_close=3000,
           )
   
       while True:
           # Do nothing if no change.
           time.sleep(0.02)
           if not gui_elements.changed:
               continue
   
           gui_elements.changed = False
   
           # If anything has changed, re-compute SMPL outputs.
           smpl_outputs = model.get_outputs(
               betas=np.array([x.value for x in gui_elements.gui_betas]),
               joint_rotmats=tf.SO3.exp(
                   # (num_joints, 3)
                   np.array([x.value for x in gui_elements.gui_joints])
               ).as_matrix(),
           )
   
           # Update the mesh properties based on the SMPL model output + GUI
           # elements.
           body_handle.vertices = smpl_outputs.vertices
           body_handle.wireframe = gui_elements.gui_wireframe.value
           body_handle.color = gui_elements.gui_rgb.value
           vertex_selector.batched_positions = smpl_outputs.vertices
   
           # Match transform control gizmos to joint positions.
           for i, control in enumerate(gui_elements.transform_controls):
               control.position = smpl_outputs.T_parent_joint[i, :3, 3]
   
   
   @dataclass
   class GuiElements:
   
       gui_rgb: viser.GuiInputHandle[tuple[int, int, int]]
       gui_wireframe: viser.GuiInputHandle[bool]
       gui_betas: list[viser.GuiInputHandle[float]]
       gui_joints: list[viser.GuiInputHandle[tuple[float, float, float]]]
       transform_controls: list[viser.TransformControlsHandle]
   
       changed: bool
   
   
   def make_gui_elements(
       server: viser.ViserServer,
       num_betas: int,
       num_joints: int,
       parent_idx: np.ndarray,
   ) -> GuiElements:
   
       tab_group = server.gui.add_tab_group()
   
       def set_changed(_) -> None:
           out.changed = True  # out is define later!
   
       # GUI elements: mesh settings + visibility.
       with tab_group.add_tab("View", viser.Icon.VIEWFINDER):
           gui_rgb = server.gui.add_rgb("Color", initial_value=(90, 200, 255))
           gui_wireframe = server.gui.add_checkbox("Wireframe", initial_value=False)
           gui_show_controls = server.gui.add_checkbox("Handles", initial_value=True)
   
           gui_rgb.on_update(set_changed)
           gui_wireframe.on_update(set_changed)
   
           @gui_show_controls.on_update
           def _(_):
               for control in transform_controls:
                   control.visible = gui_show_controls.value
   
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
               beta.on_update(set_changed)
   
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
   
           gui_joints: list[viser.GuiInputHandle[tuple[float, float, float]]] = []
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
       transform_controls: list[viser.TransformControlsHandle] = []
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
       )
       return out
   
   
   if __name__ == "__main__":
       tyro.cli(main, description=__doc__)
   
