from typing import TYPE_CHECKING, Tuple, TypeVar, Union, cast

import numpy as onp

if TYPE_CHECKING:
    from .._base import MatrixLieGroup


T = TypeVar("T", bound="MatrixLieGroup")


def get_epsilon(dtype: onp.dtype) -> float:
    """Helper for grabbing type-specific precision constants.

    Args:
        dtype: Datatype.

    Returns:
        Output float.
    """
    if dtype == onp.float32:
        return 1e-5
    elif dtype == onp.float64:
        return 1e-10
    else:
        assert False


def get_taylor_threshold(dtype: onp.dtype) -> float:
    """Angle ``|theta|`` below which a small-angle Taylor expansion is used for
    the SE3 coefficients whose closed forms suffer catastrophic cancellation:
    ``(theta - sin theta) / theta**3`` (exp) and
    ``(1 - (theta/2) cot(theta/2)) / theta**2`` (log).

    Both are series in ``theta**2``; with a 3-term expansion the truncation
    error stays well below the working precision out to a crossover near
    ``(5040 * eps)**(1/6)``, where it matches the cancellation error of the
    closed form. The old ``get_epsilon`` thresholds were far too tight, leaving
    a band just above them where the closed form was already badly cancelled
    (e.g. SE3 float32 round-trip error ~4e-3). For float32 this returns ~0.29;
    for float64 ~0.01.
    """
    return float((5040.0 * onp.finfo(dtype).eps) ** (1.0 / 6.0))


TupleOfBroadcastable = TypeVar(
    "TupleOfBroadcastable",
    bound="Tuple[Union[MatrixLieGroup, onp.ndarray], ...]",
)


def broadcast_leading_axes(inputs: TupleOfBroadcastable) -> TupleOfBroadcastable:
    """Broadcast leading axes of arrays. Takes tuples of either:
    - an array, which we assume has shape (*, D).
    - a Lie group object."""

    from .._base import MatrixLieGroup

    array_inputs = [
        (
            (x.parameters(), (x.parameters_dim,))
            if isinstance(x, MatrixLieGroup)
            else (x, x.shape[-1:])
        )
        for x in inputs
    ]
    for array, shape_suffix in array_inputs:
        assert array.shape[-len(shape_suffix) :] == shape_suffix
    batch_axes = onp.broadcast_shapes(
        *[array.shape[: -len(suffix)] for array, suffix in array_inputs]
    )
    broadcasted_arrays = tuple(
        onp.broadcast_to(array, batch_axes + shape_suffix)
        for (array, shape_suffix) in array_inputs
    )
    return cast(
        TupleOfBroadcastable,
        tuple(
            array if not isinstance(inp, MatrixLieGroup) else type(inp)(array)
            for array, inp in zip(broadcasted_arrays, inputs)
        ),
    )
