Games
=====

Two-player games demonstrating click interactions and game state management.

**Features:**

* Click interactions on game board objects
* Multi-client game state synchronization
* Turn-based gameplay mechanics
* Dynamic scene updates for game boards

**Source:** ``examples/04_demos/05_games.py``

.. figure:: ../../_static/examples/04_demos_05_games.png
   :width: 100%
   :alt: Games

Code
----

.. code-block:: python
   :linenos:

   import time
   from typing import Literal
   
   import numpy as np
   import trimesh.creation
   from typing_extensions import assert_never
   
   import viser
   import viser.transforms as tf
   
   
   def main() -> None:
       server = viser.ViserServer()
       play_connect_4(server)
   
       server.gui.add_button("Tic-Tac-Toe").on_click(lambda _: play_tic_tac_toe(server))
       server.gui.add_button("Connect 4").on_click(lambda _: play_connect_4(server))
   
       while True:
           time.sleep(10.0)
   
   
   def play_connect_4(server: viser.ViserServer) -> None:
       server.scene.reset()
   
       num_rows = 6
       num_cols = 7
   
       whose_turn: Literal["red", "yellow"] = "red"
       pieces_in_col = [0] * num_cols
   
       # Create the board frame.
       for col in range(num_cols):
           for row in range(num_rows):
               server.scene.add_mesh_trimesh(
                   f"/structure/{row}_{col}",
                   trimesh.creation.annulus(0.45, 0.55, 0.125),
                   position=(0.0, col, row),
                   wxyz=tf.SO3.from_y_radians(np.pi / 2.0).wxyz,
               )
   
       # Create a sphere to click on for each column.
       def setup_column(col: int) -> None:
           sphere = server.scene.add_icosphere(
               f"/spheres/{col}",
               radius=0.25,
               position=(0, col, num_rows - 0.25),
               color=(255, 255, 255),
           )
   
           # Drop piece into the column.
           @sphere.on_click
           def _(_) -> None:
               nonlocal whose_turn
               whose_turn = "red" if whose_turn != "red" else "yellow"
   
               row = pieces_in_col[col]
               if row == num_rows - 1:
                   sphere.remove()
   
               pieces_in_col[col] += 1
               cylinder = trimesh.creation.cylinder(radius=0.4, height=0.125)
               piece = server.scene.add_mesh_simple(
                   f"/game_pieces/{row}_{col}",
                   cylinder.vertices,
                   cylinder.faces,
                   wxyz=tf.SO3.from_y_radians(np.pi / 2.0).wxyz,
                   color={"red": (255, 0, 0), "yellow": (255, 255, 0)}[whose_turn],
               )
               for row_anim in np.linspace(num_rows - 1, row, num_rows - row + 1):
                   piece.position = (
                       0,
                       col,
                       row_anim,
                   )
                   time.sleep(1.0 / 30.0)
   
       for col in range(num_cols):
           setup_column(col)
   
   
   def play_tic_tac_toe(server: viser.ViserServer) -> None:
       server.scene.reset()
   
       whose_turn: Literal["x", "o"] = "x"
   
       for i in range(4):
           server.scene.add_spline_catmull_rom(
               f"/gridlines/{i}",
               ((-0.5, -1.5, 0), (-0.5, 1.5, 0)),
               color=(127, 127, 127),
               position=(1, 1, 0),
               wxyz=tf.SO3.from_z_radians(np.pi / 2 * i).wxyz,
           )
   
       def draw_symbol(symbol: Literal["x", "o"], i: int, j: int) -> None:
           for scale in np.linspace(0.01, 1.0, 5):
               if symbol == "x":
                   for k in range(2):
                       server.scene.add_box(
                           f"/symbols/{i}_{j}/{k}",
                           dimensions=(0.7 * scale, 0.125 * scale, 0.125),
                           position=(i, j, 0),
                           color=(0, 0, 255),
                           wxyz=tf.SO3.from_z_radians(np.pi / 2.0 * k + np.pi / 4.0).wxyz,
                       )
               elif symbol == "o":
                   mesh = trimesh.creation.annulus(0.25 * scale, 0.35 * scale, 0.125)
                   server.scene.add_mesh_simple(
                       f"/symbols/{i}_{j}",
                       mesh.vertices,
                       mesh.faces,
                       position=(i, j, 0),
                       color=(255, 0, 0),
                   )
               else:
                   assert_never(symbol)
               server.flush()
               time.sleep(1.0 / 30.0)
   
       def setup_cell(i: int, j: int) -> None:
           sphere = server.scene.add_icosphere(
               f"/spheres/{i}_{j}",
               radius=0.25,
               position=(i, j, 0),
               color=(255, 255, 255),
           )
   
           @sphere.on_click
           def _(_) -> None:
               nonlocal whose_turn
               whose_turn = "x" if whose_turn != "x" else "o"
               sphere.remove()
               draw_symbol(whose_turn, i, j)
   
       for i in range(3):
           for j in range(3):
               setup_cell(i, j)
   
   
   if __name__ == "__main__":
       main()
   
