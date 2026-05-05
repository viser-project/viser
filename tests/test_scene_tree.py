from unittest.mock import patch

import viser
import viser._client_autobuild


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_parent_removes_children() -> None:
    """Removing a parent node should cascade to all descendants."""
    server = viser.ViserServer()

    parent = server.scene.add_frame("/parent")
    child = server.scene.add_frame("/parent/child")
    grandchild = server.scene.add_frame("/parent/child/grandchild")

    parent.remove()

    assert parent._impl.removed
    assert child._impl.removed
    assert grandchild._impl.removed
    assert "/parent" not in server.scene._handle_from_node_name
    assert "/parent/child" not in server.scene._handle_from_node_name
    assert "/parent/child/grandchild" not in server.scene._handle_from_node_name


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_leaf_preserves_parent() -> None:
    """Removing a leaf node should not affect its parent."""
    server = viser.ViserServer()

    parent = server.scene.add_frame("/parent")
    child = server.scene.add_frame("/parent/child")

    child.remove()

    assert not parent._impl.removed
    assert child._impl.removed
    assert "/parent" in server.scene._handle_from_node_name
    assert "/parent/child" not in server.scene._handle_from_node_name
    # Child should be removed from parent's children set.
    assert "/parent/child" not in server.scene._children_from_node_name.get(
        "/parent", set()
    )


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_get_handle_by_name() -> None:
    """get_handle_by_name should return handles and None appropriately."""
    server = viser.ViserServer()

    handle = server.scene.add_frame("/test_node")
    assert server.scene.get_handle_by_name("/test_node") is handle

    handle.remove()
    assert server.scene.get_handle_by_name("/test_node") is None


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_get_handle_by_name_after_parent_removal() -> None:
    """Children should not be findable after parent removal."""
    server = viser.ViserServer()

    server.scene.add_frame("/a")
    server.scene.add_frame("/a/b")

    server.scene.get_handle_by_name("/a").remove()  # type: ignore

    assert server.scene.get_handle_by_name("/a") is None
    assert server.scene.get_handle_by_name("/a/b") is None


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_intermediate_frames_auto_created() -> None:
    """Adding /a/b/c should auto-create /a and /a/b as invisible frames."""
    server = viser.ViserServer()

    server.scene.add_frame("/a/b/c")

    assert "/a" in server.scene._handle_from_node_name
    assert "/a/b" in server.scene._handle_from_node_name
    assert "/a/b/c" in server.scene._handle_from_node_name

    # Intermediate frames should be invisible (show_axes=False).
    a_handle = server.scene._handle_from_node_name["/a"]
    ab_handle = server.scene._handle_from_node_name["/a/b"]
    assert not a_handle._impl.props.show_axes
    assert not ab_handle._impl.props.show_axes


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_with_intermediate_frames() -> None:
    """Removing a root node should cascade through auto-created intermediates."""
    server = viser.ViserServer()

    server.scene.add_frame("/a/b/c")

    a_handle = server.scene._handle_from_node_name["/a"]
    ab_handle = server.scene._handle_from_node_name["/a/b"]
    abc_handle = server.scene._handle_from_node_name["/a/b/c"]

    a_handle.remove()

    assert a_handle._impl.removed
    assert ab_handle._impl.removed
    assert abc_handle._impl.removed
    assert "/a" not in server.scene._handle_from_node_name
    assert "/a/b" not in server.scene._handle_from_node_name
    assert "/a/b/c" not in server.scene._handle_from_node_name


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_name_normalized_with_leading_slash() -> None:
    """Names without a leading '/' should be normalized."""
    server = viser.ViserServer()

    handle = server.scene.add_frame("grandparent/parent/child")

    # Should be stored with leading slash.
    assert handle.name == "/grandparent/parent/child"
    assert "/grandparent/parent/child" in server.scene._handle_from_node_name

    # Ancestors should also be normalized.
    assert "/grandparent" in server.scene._handle_from_node_name
    assert "/grandparent/parent" in server.scene._handle_from_node_name

    # Lookup should work with or without leading slash.
    assert server.scene.get_handle_by_name("/grandparent/parent/child") is handle
    assert server.scene.get_handle_by_name("grandparent/parent/child") is handle


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_remove_by_name_without_leading_slash() -> None:
    """remove_by_name should work without a leading '/'."""
    server = viser.ViserServer()

    server.scene.add_frame("grandparent/parent/child")
    server.scene.remove_by_name("grandparent")

    assert "/grandparent" not in server.scene._handle_from_node_name
    assert "/grandparent/parent" not in server.scene._handle_from_node_name
    assert "/grandparent/parent/child" not in server.scene._handle_from_node_name


@patch.object(viser._client_autobuild, "ensure_client_is_built", lambda: None)
def test_cascade_removal_without_leading_slash() -> None:
    """Cascade removal should work for nodes added without leading '/'."""
    server = viser.ViserServer()

    grandparent = server.scene.add_frame("grandparent")
    parent = server.scene.add_frame("grandparent/parent")
    child = server.scene.add_frame("grandparent/parent/child")

    grandparent.remove()

    assert grandparent._impl.removed
    assert parent._impl.removed
    assert child._impl.removed
