Theming
=======

Customize the appearance with custom titles, logos, and navigation buttons.

**Features:**

* :class:`viser.theme.TitlebarConfig` for custom titlebar configuration
* :class:`viser.theme.TitlebarButton` for navigation buttons
* :class:`viser.theme.TitlebarImage` for custom logos
* Brand color customization and visual styling

**Source:** ``examples/02_gui/05_theming.py``

.. figure:: ../../_static/examples/02_gui_05_theming.png
   :width: 100%
   :alt: Theming

Code
----

.. code-block:: python
   :linenos:

   import time
   
   import viser
   from viser.theme import TitlebarButton, TitlebarConfig, TitlebarImage
   
   
   def main():
       server = viser.ViserServer(label="Viser Theming")
   
       buttons = (
           TitlebarButton(
               text="Getting Started",
               icon=None,
               href="https://nerf.studio",
           ),
           TitlebarButton(
               text="Github",
               icon="GitHub",
               href="https://github.com/nerfstudio-project/nerfstudio",
           ),
           TitlebarButton(
               text="Documentation",
               icon="Description",
               href="https://docs.nerf.studio",
           ),
       )
       image = TitlebarImage(
           image_url_light="https://docs.nerf.studio/_static/imgs/logo.png",
           image_url_dark="https://docs.nerf.studio/_static/imgs/logo-dark.png",
           image_alt="NerfStudio Logo",
           href="https://docs.nerf.studio/",
       )
       titlebar_theme = TitlebarConfig(buttons=buttons, image=image)
   
       server.gui.add_markdown(
           "Viser includes support for light theming via the `.configure_theme()` method."
       )
   
       gui_theme_code = server.gui.add_markdown("no theme applied yet")
   
       # GUI elements for controllable values.
       titlebar = server.gui.add_checkbox("Titlebar", initial_value=True)
       dark_mode = server.gui.add_checkbox("Dark mode", initial_value=True)
       show_logo = server.gui.add_checkbox("Show logo", initial_value=True)
       show_share_button = server.gui.add_checkbox("Show share button", initial_value=True)
       brand_color = server.gui.add_rgb("Brand color", (230, 180, 30))
       control_layout = server.gui.add_dropdown(
           "Control layout", ("floating", "fixed", "collapsible")
       )
       control_width = server.gui.add_dropdown(
           "Control width", ("small", "medium", "large"), initial_value="medium"
       )
       synchronize = server.gui.add_button("Apply theme", icon=viser.Icon.CHECK)
   
       def synchronize_theme() -> None:
           server.gui.configure_theme(
               titlebar_content=titlebar_theme if titlebar.value else None,
               control_layout=control_layout.value,
               control_width=control_width.value,
               dark_mode=dark_mode.value,
               show_logo=show_logo.value,
               show_share_button=show_share_button.value,
               brand_color=brand_color.value,
           )
           gui_theme_code.content = f"""
               ### Current applied theme
               ```
               server.gui.configure_theme(
                   titlebar_content={"titlebar_content" if titlebar.value else None},
                   control_layout="{control_layout.value}",
                   control_width="{control_width.value}",
                   dark_mode={dark_mode.value},
                   show_logo={show_logo.value},
                   show_share_button={show_share_button.value},
                   brand_color={brand_color.value},
               )
               ```
