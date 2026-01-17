import os
import shutil
import time
from pathlib import Path

import tomllib
from rich import print

from .mapping import ROOT
from .system import SudoRunner

CONFIGS_DIR = ROOT / "configs"
MANIFEST_FILE = CONFIGS_DIR / "manifest.toml"


def _load_manifest() -> list[dict[str, object]]:
    """Load the config deployment manifest."""
    if not MANIFEST_FILE.exists():
        print("[yellow]No configs/manifest.toml found[/yellow]")
        return []
    try:
        data = tomllib.loads(MANIFEST_FILE.read_text())
    except tomllib.TOMLDecodeError:
        print("[yellow]Invalid configs/manifest.toml; ignoring[/yellow]")
        return []
    entries = data.get("files", [])
    if not isinstance(entries, list):
        print("[yellow]configs/manifest.toml: files must be a list[/yellow]")
        return []
    return [e for e in entries if isinstance(e, dict)]


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


def deploy_configs(runner: SudoRunner | None = None) -> None:
    """Deploy configuration files from the manifest."""
    entries = _load_manifest()
    if not entries:
        return

    owns_runner = False
    try:
        for entry in entries:
            src_rel = entry.get("src")
            dest_str = entry.get("dest")
            if not isinstance(src_rel, str) or not isinstance(dest_str, str):
                print("[yellow]Invalid manifest entry; missing src/dest[/yellow]")
                continue
            src = CONFIGS_DIR / src_rel
            if not src.exists():
                print(f"[yellow]Missing source file: {src}[/yellow]")
                continue
            dest = Path(dest_str)
            if not dest.is_absolute():
                print(f"[yellow]Destination must be absolute: {dest}[/yellow]")
                continue

            owner = entry.get("owner")
            group = entry.get("group")
            owner = owner if isinstance(owner, str) and owner else None
            group = group if isinstance(group, str) and group else None
            mode = _parse_mode(entry.get("mode"))
            backup = entry.get("backup", True) is not False

            needs_sudo = _needs_sudo(dest, owner, group)
            if needs_sudo and runner is None:
                runner = SudoRunner()
                owns_runner = True
            if needs_sudo and runner and not runner.start():
                return

            timestamp = time.strftime("%Y%m%d%H%M%S")
            backup_path = dest.with_suffix(dest.suffix + f".bak.{timestamp}")

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
