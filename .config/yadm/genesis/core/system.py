import shutil
import subprocess
import threading
from typing import Optional

from rich import print

PKG_MANAGERS = {
    "pacman": ["pacman", "-S", "--needed"],
    "apt-get": ["apt-get", "install", "-y"],
    "dnf": ["dnf", "install", "-y"],
    "zypper": ["zypper", "install", "-y"],
    "xbps-install": ["xbps-install", "-Sy"],
    "apk": ["apk", "add"],
    "emerge": ["emerge", "--ask=n"],
    "brew": ["brew", "install"],
}

NO_SUDO = {"brew"}


def detect_pkg_manager() -> Optional[tuple[str, list[str]]]:
    """Detect the first available package manager in PATH.

    Returns:
        A tuple of (manager_name, base_command) if found, otherwise None.
    """
    for name, cmd in PKG_MANAGERS.items():
        if shutil.which(name):
            return name, cmd
    return None


class SudoRunner:
    """Manage sudo authentication and keepalive for a series of commands."""

    def __init__(self) -> None:
        self._stop_event = threading.Event()
        self._thread = threading.Thread(
            target=self._keepalive, args=(self._stop_event,), daemon=True
        )
        self._started = False

    def _keepalive(self, stop_event: threading.Event) -> None:
        """Periodically refresh sudo privileges."""

        while not stop_event.wait(240):
            subprocess.run(
                ["sudo", "-v"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )

    def start(self) -> bool:
        """Authenticate sudo and start the keepalive thread."""

        if self._started:
            return True

        if subprocess.run(["sudo", "-v"]).returncode != 0:
            print("[red]sudo authentication failed[/red]")
            return False

        self._thread.start()
        self._started = True
        return True

    def run(self, cmd: list[str]) -> None:
        """Run a command through sudo without prompting."""

        subprocess.run(["sudo", "-n"] + cmd, check=False)

    def stop(self) -> None:
        """Stop the keepalive thread."""

        if not self._started:
            return

        self._stop_event.set()
        self._thread.join(timeout=1)
        self._started = False


def install_system(pkgs: list[str], runner: Optional[SudoRunner] = None) -> bool:
    """Install packages via the detected system package manager.

    This triggers sudo authentication (interactive) and then keeps the
    sudo credential alive while installing packages.

    Args:
        pkgs: List of package names to install.
        runner: Optional shared SudoRunner for reuse across tasks.

    Returns:
        True if a supported package manager was found and invoked; False otherwise.
    """
    detected = detect_pkg_manager()
    if not detected:
        print("[yellow]No supported package manager found[/yellow]")
        return False
    name, cmd = detected

    if name in NO_SUDO:
        subprocess.run(cmd + pkgs, check=False)
        return True

    owns_runner: bool = False
    if runner is None:
        runner = SudoRunner()
        owns_runner = True

    if not runner.start():
        return False

    runner.run(cmd + pkgs)
    if owns_runner:
        runner.stop()

    return True
