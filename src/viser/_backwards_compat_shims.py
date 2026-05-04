from __future__ import annotations

import functools
import inspect
import warnings
from typing import Any, Callable, TypeVar

TCallable = TypeVar("TCallable", bound=Callable)


def deprecated_positional_shim(
    func: TCallable,
    deprecated_kwargs: tuple[str, ...] = (),
) -> TCallable:
    """Temporary shim to allow (deprecated) positional use of keyword-only
    arguments. This is for compatibility with the viser API from version
    <=0.2.23.

    When a function is called:
    - We try to call it with the given arguments.
    - If it raises a positional arguments TypeError, we catch it, raise a
      warning, convert the arguments to keyword arguments, and call the
      function again with the keyword arguments.

    We also support the `deprecated_kwargs` argument, which is a list of
    keyword arguments that are deprecated, ignored, and will be removed in the
    future.
    """

    @functools.wraps(func)
    def inner(*args, **kwargs):
        for kw in deprecated_kwargs:
            if kw not in kwargs:
                continue
            kwargs.pop(kw)
            warnings.warn(
                f"The {kw} keyword argument is deprecated and will be removed.",
                category=DeprecationWarning,
                stacklevel=2,
            )

        try:
            return func(*args, **kwargs)
        except TypeError as e:
            # Check if this is a positional argument error.
            error_msg = str(e)
            if "positional argument" in error_msg or "takes" in error_msg:
                # Get function signature to map positional args to keyword args.
                sig = inspect.signature(func)
                param_names = list(sig.parameters.keys())

                # Convert excess positional args to keyword args.
                if len(args) > len(
                    [p for p in sig.parameters.values() if p.kind != p.KEYWORD_ONLY]
                ):
                    # Find where positional args end and keyword-only args begin.
                    pos_or_kw_count = sum(
                        1
                        for p in sig.parameters.values()
                        if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD)
                    )

                    # Split args into positional and to-be-converted-to-keyword.
                    pos_args = args[:pos_or_kw_count]
                    extra_args = args[pos_or_kw_count:]

                    # Map extra positional args to keyword args.
                    extra_kwargs = {}
                    for i, arg in enumerate(extra_args):
                        if pos_or_kw_count + i < len(param_names):
                            param_name = param_names[pos_or_kw_count + i]
                            extra_kwargs[param_name] = arg

                    # Merge with existing kwargs.
                    new_kwargs = {**extra_kwargs, **kwargs}

                    # Issue deprecation warning with specific parameter names.
                    converted_params = list(extra_kwargs.keys())
                    import rich

                    func_name = getattr(func, "__name__", "<unknown>")
                    rich.print(
                        f"[bold](viser)[/bold] Passing {converted_params} as positional arguments to {func_name} "
                        f"is deprecated. Please use keyword arguments instead: {', '.join(f'{k}={v}' for k, v in extra_kwargs.items())}",
                    )
                    warnings.warn(
                        f"Passing {converted_params} as positional arguments to {func_name} "
                        f"is deprecated. Please use keyword arguments instead: {', '.join(f'{k}={v}' for k, v in extra_kwargs.items())}",
                        category=DeprecationWarning,
                        stacklevel=2,
                    )

                    return func(*pos_args, **new_kwargs)

            # Re-raise if it's not a positional argument error.
            raise

    return inner  # type: ignore


class DeprecatedAttributeShim:
    """Shims for backward compatibility with viser API from version
    `<=0.1.30`."""

    def __getattr__(self, name: str) -> Any:
        fixed_name = {
            # Map from old method names (viser v0.1.*) to new methods names.
            "reset_scene": "reset",
            "set_global_scene_node_visibility": "set_global_visibility",
            "on_scene_pointer": "on_pointer_event",
            "on_scene_pointer_removed": "on_pointer_callback_removed",
            "remove_scene_pointer_callback": "remove_pointer_callback",
            "add_mesh": "add_mesh_simple",
        }.get(name, name)
        if hasattr(self.scene, fixed_name):
            warnings.warn(
                f"{type(self).__name__}.{name} has been deprecated, use {type(self).__name__}.scene.{fixed_name} instead. Alternatively, pin to `viser<0.2.0`.",
                category=DeprecationWarning,
                stacklevel=2,
            )
            return object.__getattribute__(self.scene, fixed_name)

        fixed_name = name.replace("add_gui_", "add_").replace("set_gui_", "set_")
        if hasattr(self.gui, fixed_name):
            warnings.warn(
                f"{type(self).__name__}.{name} has been deprecated, use {type(self).__name__}.gui.{fixed_name} instead. Alternatively, pin to `viser<0.2.0`.",
                category=DeprecationWarning,
                stacklevel=2,
            )
            return object.__getattribute__(self.gui, fixed_name)

        raise AttributeError(
            f"'{type(self).__name__}' object has no attribute '{name}'"
        )
