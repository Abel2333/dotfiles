import os
import shutil
import subprocess
import time
from pathlib import Path

import tomllib
from rich import print
from pydantic import ValidationError

from .models import ConfigManifest, ConfigFileEntry
from .mapping import ROOT, detect_distro_ids
from .system import SudoRunner

CONFIGS_DIR = ROOT / "configs"
MANIFEST_FILE = CONFIGS_DIR / "manifest.toml"


def _load_manifest() -> list[ConfigFileEntry]:
    """Load the config deployment manifest."""
    if not MANIFEST_FILE.exists():
        print("[yellow]No configs/manifest.toml found[/yellow]")
        return []
    try:
        data = tomllib.loads(MANIFEST_FILE.read_text())
    except tomllib.TOMLDecodeError:
        print("[yellow]Invalid configs/manifest.toml; ignoring[/yellow]")
        return []
    try:
        manifest = ConfigManifest.model_validate(data)
    except ValidationError:
        print("[yellow]configs/manifest.toml: invalid schema[/yellow]")
        return []
    return manifest.files


def _needs_sudo(dest: Path, owner: str | None, group: str | None) -> bool:
    if owner or group:
        return True
    if str(dest).startswith("/etc/"):
        return True
    parent = dest.parent if dest.parent != Path(".") else Path.cwd()
    return not os.access(parent, os.W_OK)


def _parse_mode(value: object) -> str | None:
    if value is None:
        return None
    if isinstance(value, int):
        return f"{value:o}"
    if isinstance(value, str) and value:
        return value
    return None


def _matches_only(only: list[str]) -> bool:
    if not only:
        return True
    distro_ids = detect_distro_ids()
    return any(item in distro_ids for item in only)


def _sync_dir(src: Path, dest: Path, runner: SudoRunner | None) -> None:
    cmd = ["rsync", "-a"]
    if runner:
        cmd += ["--chown=root:root"]
    cmd += [f"{src}/", f"{dest}/"]
    if runner:
        runner.run(cmd)
    else:
        subprocess.run(cmd, check=False)


def deploy_configs(runner: SudoRunner | None = None) -> None:
    """Deploy configuration files from the manifest."""
    entries = _load_manifest()
    if not entries:
        return

    owns_runner = False
    try:
        for entry in entries:
            if not _matches_only(entry.only):
                continue
            src = CONFIGS_DIR / entry.src
            if not src.exists():
                print(f"[yellow]Missing source file: {src}[/yellow]")
                continue
            dest = Path(entry.dest)
            if not dest.is_absolute():
                print(f"[yellow]Destination must be absolute: {dest}[/yellow]")
                continue

            owner = entry.owner
            group = entry.group
            mode = _parse_mode(entry.mode)
            backup = entry.backup is not False

            needs_sudo = _needs_sudo(dest, owner, group)
            if needs_sudo and runner is None:
                runner = SudoRunner()
                owns_runner = True
            if needs_sudo and runner and not runner.start():
                return

            timestamp = time.strftime("%Y%m%d%H%M%S")
            backup_path = dest.with_suffix(dest.suffix + f".bak.{timestamp}")

            if entry.type == "dir":
                if backup and dest.exists():
                    backup_path = dest.with_suffix(dest.suffix + f".bak.{timestamp}")
                    if runner:
                        runner.run(["cp", "-a", str(dest), str(backup_path)])
                    else:
                        shutil.copytree(dest, backup_path)
                if needs_sudo and runner:
                    _sync_dir(src, dest, runner)
                else:
                    dest.mkdir(parents=True, exist_ok=True)
                    _sync_dir(src, dest, None)
                continue

            if needs_sudo and runner:
                if backup and dest.exists():
                    runner.run(["cp", "-a", str(dest), str(backup_path)])
                cmd = ["install", "-D"]
                if mode:
                    cmd += ["-m", mode]
                if owner:
                    cmd += ["-o", owner]
                if group:
                    cmd += ["-g", group]
                cmd += [str(src), str(dest)]
                runner.run(cmd)
            else:
                if backup and dest.exists():
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(dest, backup_path)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, dest)
                if mode:
                    os.chmod(dest, int(mode, 8))
    finally:
        if runner and owns_runner:
            runner.stop()
