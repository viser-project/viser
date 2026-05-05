from typing import Union

import numpy as np
import numpy.typing as npt

# Type aliases Numpy arrays; primarily for function inputs.

Scalar = Union[float, npt.NDArray[np.floating]]
"""Type alias for `Union[float, Array]`."""


__all__ = [
    "Scalar",
]
