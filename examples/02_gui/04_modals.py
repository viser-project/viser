"""Modal dialogs

Create popup modal dialogs for user input, confirmations, or detailed information display.

**Features:**

* :meth:`viser.GuiApi.add_modal` for creating modal dialogs
* Dynamic modal content with markdown and controls
* Modal title updates and content management
* Context managers for automatic modal handling
"""

import time

import viser


def main():
    server = viser.ViserServer()

    @server.on_client_connect
    def _(client: viser.ClientHandle) -> None:
        with client.gui.add_modal("Modal example"):
            client.gui.add_markdown(
                "**The input below determines the title of the modal...**"
            )

            gui_title = client.gui.add_text(
                "Title",
                initial_value="My Modal",
            )

            modal_button = client.gui.add_button("Show more modals")

            @modal_button.on_click
            def _(_) -> None:
                with client.gui.add_modal(gui_title.value) as modal:
                    client.gui.add_markdown("This is content inside the modal!")
                    client.gui.add_button("Close").on_click(lambda _: modal.close())

    while True:
        time.sleep(0.15)


if __name__ == "__main__":
    main()
