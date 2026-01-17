import os
import shutil
import subprocess
from pathlib import Path

from rich import print

from .configs import deploy_configs
from .mapping import ROOT, load_package_list, resolve_items
from .system import SudoRunner, install_system


def has_root() -> bool:
    """Check whether the current process is running as root.

    Returns:
        True if the effective UID is 0, otherwise False.
    """
    return os.geteuid() == 0


def install_source(pkgs: list[str]) -> None:
    """Placeholder for source-based installs when system packages are not used.

    Args:
        pkgs: List of package names requested for installation.
    """
    print("[yellow]Source install not implemented yet[/yellow]")
    print(f"[yellow]Requested packages: {', '.join(pkgs)}[/yellow]")


def install_cargo(items: list[dict[str, object]]) -> None:
    """Install cargo-based packages listed in items.

    Args:
        items: Normalized install items with method "cargo".
    """
    if not items:
        return
    if not shutil.which("cargo"):
        print("[yellow]cargo not found; skipping cargo installs[/yellow]")
        return
    for item in items:
        name = str(item["name"])
        subprocess.run(["cargo", "install", name], check=False)


def _script_path(item: dict[str, object]) -> Path | None:
    """Resolve a script path from an item.

    Args:
        item: Normalized install item for method "script".

    Returns:
        Absolute path to the script, or None if not found.
    """
    script = item.get("script") or item.get("name")
    if not isinstance(script, str) or not script:
        return None
    path = ROOT / "scripts" / script
    if path.exists():
        return path
    return None


def install_script(items: list[dict[str, object]]) -> None:
    """Run script-based installers from the local scripts directory.

    Args:
        items: Normalized install items with method "script".
    """
    for item in items:
        path = _script_path(item)
        if not path:
            print(f"[yellow]Missing script for {item.get('name')}[/yellow]")
            continue
        args = item.get("args", [])
        cmd = ["/bin/bash", str(path)]
        if isinstance(args, list):
            cmd += [str(a) for a in args]
        subprocess.run(cmd, check=False)


def run_post(items: list[dict[str, object]]) -> None:
    """Run post-install commands for the given items.

    Args:
        items: Normalized install items that may include post commands.
    """
    for item in items:
        post = item.get("post", [])
        if not isinstance(post, list):
            continue
        for cmd in post:
            if isinstance(cmd, str) and cmd.strip():
                subprocess.run(cmd, shell=True, check=False)


def install_packages(mode: str, runner: SudoRunner | None = None) -> None:
    """Install packages according to the selected mode and mapping rules.

    Args:
        mode: Installation mode, either "system" or "source".
        runner: Optional shared SudoRunner for reuse across tasks.
    """
    pkgs = load_package_list()
    if not pkgs:
        return

    items = resolve_items(pkgs)
    if has_root():
        print("[red]Do not run as root[/red]")
        return

    print(f"[green]Installing packages (mode: {mode})...[/green]")

    if mode == "source":
        install_source(pkgs)
        return

    system_items = [i for i in items if i.get("method") == "system"]
    cargo_items = [i for i in items if i.get("method") == "cargo"]
    script_items = [i for i in items if i.get("method") == "script"]

    if system_items:
        system_names = [str(i["name"]) for i in system_items]
        install_system(system_names, runner=runner)
        run_post(system_items)
    if cargo_items:
        install_cargo(cargo_items)
        run_post(cargo_items)
    if script_items:
        install_script(script_items)
        run_post(script_items)


def run_tasks(mode: str, task: str) -> None:
    """Run selected tasks.

    Args:
        mode: Installation mode for packages.
        task: Task selector: "install", "config", or "all".
    """
    runner = SudoRunner()
    try:
        if task in ("install", "all"):
            install_packages(mode, runner=runner)
        if task in ("config", "all"):
            deploy_configs(runner=runner)
    finally:
        runner.stop()
