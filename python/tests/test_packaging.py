from __future__ import annotations

import email
import subprocess
import sys
import tarfile
from pathlib import Path
from zipfile import ZipFile


def test_wheel_and_sdist_include_license_and_zero_runtime_dependencies(
    tmp_path: Path,
) -> None:
    project = Path(__file__).parents[1]
    subprocess.run(
        [
            sys.executable,
            "-m",
            "build",
            "--outdir",
            str(tmp_path),
            str(project),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    wheel = next(tmp_path.glob("*.whl"))
    sdist = next(tmp_path.glob("*.tar.gz"))

    with ZipFile(wheel) as archive:
        names = archive.namelist()
        metadata_name = next(
            name for name in names if name.endswith(".dist-info/METADATA")
        )
        metadata = email.message_from_bytes(archive.read(metadata_name))
        assert any(name.endswith(".dist-info/licenses/LICENSE") for name in names)
        assert any(name.endswith("headless_cli/py.typed") for name in names)
        assert metadata["Requires-Python"] == ">=3.10"
        requirements = metadata.get_all("Requires-Dist", [])
        assert all("extra == 'test'" in requirement for requirement in requirements)

    with tarfile.open(sdist) as archive:
        assert any(name.endswith("/LICENSE") for name in archive.getnames())
