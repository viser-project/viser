from dataclasses import is_dataclass
from typing import get_type_hints

from viser.infra._messages import Message


def test_get_annotations() -> None:
    """Check that we can read the type annotations from all messages.

    This is to guard against use of Python annotations that can't be inspected at runtime.
    We could also use `eval_type_backport`: https://github.com/alexmojaki/eval_type_backport
    """

    def recursive_get_type_hints(cls: type) -> None:
        try:
            hints = get_type_hints(cls)
        except TypeError as e:
            raise TypeError(f"Failed to get type hints for {cls}") from e

        assert hints is not None
        for hint in hints.values():
            if is_dataclass(hint):
                recursive_get_type_hints(hint)  # type: ignore

    for cls in Message.get_subclasses():
        recursive_get_type_hints(cls)
