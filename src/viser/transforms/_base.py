import abc
from typing import ClassVar, Generic, Tuple, TypeVar, Union, overload

import numpy as np
import numpy.typing as npt
from typing_extensions import Self, final, get_args, override


class MatrixLieGroup(abc.ABC):
    """Interface definition for matrix Lie groups."""

    matrix_dim: ClassVar[int]
    """Dimension of square matrix output from `.as_matrix()`."""

    parameters_dim: ClassVar[int]
    """Dimension of underlying parameters, `.parameters()`."""

    tangent_dim: ClassVar[int]
    """Dimension of tangent space."""

    space_dim: ClassVar[int]
    """Dimension of coordinates that can be transformed."""

    def __init__(
        # Notes:
        # - For the constructor signature to be consistent with subclasses, `parameters`
        #   should be marked as positional-only. But this isn't possible in Python 3.7.
        # - This method is implicitly overriden by the dataclass decorator and
        #   should _not_ be marked abstract.
        self,
        parameters: np.ndarray,
    ):
        """Construct a group object from its underlying parameters."""
        raise NotImplementedError()

    def __init_subclass__(
        cls,
        matrix_dim: int = 0,
        parameters_dim: int = 0,
        tangent_dim: int = 0,
        space_dim: int = 0,
    ) -> None:
        """Set class properties for subclasses. We default to dummy values."""
        cls.matrix_dim = matrix_dim
        cls.parameters_dim = parameters_dim
        cls.tangent_dim = tangent_dim
        cls.space_dim = space_dim

    # Shared implementations.

    @overload
    def __matmul__(self, other: Self) -> Self: ...

    @overload
    def __matmul__(
        self, other: npt.NDArray[np.floating]
    ) -> npt.NDArray[np.floating]: ...

    def __matmul__(
        self, other: Union[Self, npt.NDArray[np.floating]]
    ) -> Union[Self, npt.NDArray[np.floating]]:
        """Overload for the `@` operator.

        Switches between the group action (`.apply()`) and multiplication
        (`.multiply()`) based on the type of `other`.
        """
        if isinstance(other, np.ndarray):
            return self.apply(target=other)
        elif isinstance(other, MatrixLieGroup):
            assert self.space_dim == other.space_dim
            return self.multiply(other=other)  # type: ignore
        else:
            assert False, f"Invalid argument type for `@` operator: {type(other)}"

    # Factory.

    @classmethod
    @abc.abstractmethod
    def identity(
        cls, batch_axes: Tuple[int, ...] = (), dtype: npt.DTypeLike = np.float64
    ) -> Self:
        """Returns identity element.

        Args:
            batch_axes: Any leading batch axes for the output transform.
            dtype: Datatype for the output.

        Returns:
            Identity element.
        """

    @classmethod
    @abc.abstractmethod
    def from_matrix(cls, matrix: npt.NDArray[np.floating]) -> Self:
        """Get group member from matrix representation.

        Args:
            matrix: Matrix representaiton.

        Returns:
            Group member.
        """

    # Accessors.

    @abc.abstractmethod
    def as_matrix(self) -> npt.NDArray[np.floating]:
        """Get transformation as a matrix. Homogeneous for SE groups."""

    @abc.abstractmethod
    def parameters(self) -> npt.NDArray[np.floating]:
        """Get underlying representation."""

    # Operations.

    @abc.abstractmethod
    def apply(self, target: npt.NDArray[np.floating]) -> npt.NDArray[np.floating]:
        """Applies group action to a point.

        Args:
            target: Point to transform.

        Returns:
            Transformed point.
        """

    @abc.abstractmethod
    def multiply(self, other: Self) -> Self:
        """Composes this transformation with another.

        Returns:
            self @ other
        """

    @classmethod
    @abc.abstractmethod
    def exp(cls, tangent: npt.NDArray[np.floating]) -> Self:
        """Computes `expm(wedge(tangent))`.

        Args:
            tangent: Tangent vector to take the exponential of.

        Returns:
            Output.
        """

    @abc.abstractmethod
    def log(self) -> npt.NDArray[np.floating]:
        """Computes `vee(logm(transformation matrix))`.

        Returns:
            Output. Shape should be `(tangent_dim,)`.
        """

    @abc.abstractmethod
    def adjoint(self) -> npt.NDArray[np.floating]:
        """Computes the adjoint, which transforms tangent vectors between tangent
        spaces.

        More precisely, for a transform `GroupType`:
        ```
        GroupType @ exp(omega) = exp(Adj_T @ omega) @ GroupType
        ```

        In robotics, typically used for transforming twists, wrenches, and Jacobians
        across different reference frames.

        Returns:
            Output. Shape should be `(tangent_dim, tangent_dim)`.
        """

    @abc.abstractmethod
    def inverse(self) -> Self:
        """Computes the inverse of our transform.

        Returns:
            Output.
        """

    @abc.abstractmethod
    def normalize(self) -> Self:
        """Normalize/projects values and returns.

        Returns:
            Normalized group member.
        """

    @classmethod
    @abc.abstractmethod
    def sample_uniform(
        cls,
        rng: np.random.Generator,
        batch_axes: Tuple[int, ...] = (),
        dtype: npt.DTypeLike = np.float64,
    ) -> Self:
        """Draw a uniform sample from the group. Translations (if applicable) are in the
        range [-1, 1].

        Args:
            rng: numpy generator object.
            batch_axes: Any leading batch axes for the output transforms. Each
                sampled transform will be different.

        Returns:
            Sampled group member.
        """

    @final
    def get_batch_axes(self) -> Tuple[int, ...]:
        """Return any leading batch axes in contained parameters. If an array of shape
        `(100, 4)` is placed in the wxyz field of an SO3 object, for example, this will
        return `(100,)`."""
        return self.parameters().shape[:-1]


class SOBase(MatrixLieGroup):
    """Base class for special orthogonal groups."""


ContainedSOType = TypeVar("ContainedSOType", bound=SOBase)


class SEBase(Generic[ContainedSOType], MatrixLieGroup):
    """Base class for special Euclidean groups.

    Each SE(N) group member contains an SO(N) rotation, as well as an N-dimensional
    translation vector.
    """

    # SE-specific interface.

    @classmethod
    @abc.abstractmethod
    def from_rotation_and_translation(
        cls,
        rotation: ContainedSOType,
        translation: npt.NDArray[np.floating],
    ) -> Self:
        """Construct a rigid transform from a rotation and a translation.

        Args:
            rotation: Rotation term.
            translation: translation term.

        Returns:
            Constructed transformation.
        """

    @final
    @classmethod
    def from_rotation(cls, rotation: ContainedSOType) -> Self:
        return cls.from_rotation_and_translation(
            rotation=rotation,
            translation=np.zeros(
                (*rotation.get_batch_axes(), cls.space_dim),
                dtype=rotation.parameters().dtype,
            ),
        )

    @final
    @classmethod
    def from_translation(cls, translation: npt.NDArray[np.floating]) -> Self:
        # Extract rotation class from type parameter.
        assert len(cls.__orig_bases__) == 1  # type: ignore
        return cls.from_rotation_and_translation(
            rotation=get_args(cls.__orig_bases__[0])[0].identity(),  # type: ignore
            translation=translation,
        )

    @abc.abstractmethod
    def rotation(self) -> ContainedSOType:
        """Returns a transform's rotation term."""

    @abc.abstractmethod
    def translation(self) -> npt.NDArray[np.floating]:
        """Returns a transform's translation term."""

    # Overrides.

    @final
    @override
    def apply(self, target: npt.NDArray[np.floating]) -> npt.NDArray[np.floating]:
        return self.rotation() @ target + self.translation()  # type: ignore

    @final
    @override
    def multiply(self, other: Self) -> Self:  # type: ignore
        return type(self).from_rotation_and_translation(
            rotation=self.rotation() @ other.rotation(),
            translation=(self.rotation() @ other.translation()) + self.translation(),
        )

    @final
    @override
    def inverse(self) -> Self:
        R_inv = self.rotation().inverse()
        return type(self).from_rotation_and_translation(
            rotation=R_inv,
            translation=-(R_inv @ self.translation()),
        )

    @final
    @override
    def normalize(self) -> Self:
        return type(self).from_rotation_and_translation(
            rotation=self.rotation().normalize(),
            translation=self.translation(),
        )
