import socket
import time
from unittest.mock import patch

import viser
import viser._client_autobuild


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_server_port_is_freed():
    server = viser.ViserServer()
    original_port = server.get_port()

    # Assert that the port is not free.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    result = sock.connect_ex(("localhost", original_port))
    assert result == 0
    sock.close()
    server.stop()

    time.sleep(0.05)

    # Assert that the port is now free.
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    result = sock.connect_ex(("localhost", original_port))
    assert result != 0
