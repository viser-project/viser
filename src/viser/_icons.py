import zipfile
from functools import lru_cache
from pathlib import Path

from ._icons_enum import IconName

ICONS_DIR = Path(__file__).resolve().parent / "_icons"


@lru_cache(maxsize=32)
def svg_from_icon(icon_name: IconName) -> str:
    """Read an icon and return it as a UTF string; we expect this to be an
    <svg /> tag."""
    assert isinstance(icon_name, str)
    icons_zipfile = ICONS_DIR / "tabler-icons.zip"

    with zipfile.ZipFile(icons_zipfile) as zip_file:
        with zip_file.open(f"{icon_name}.svg") as icon_file:
            out = icon_file.read()

    return out.decode("utf-8")
