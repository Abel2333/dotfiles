#! /usr/bin/env python3

import argparse
import subprocess
from pathlib import Path

ROOT = Path.home() / ".config" / "yadm" / "genesis"
VENV = ROOT / "venv"
REQ = ROOT / "requirements.txt"
APP = ROOT / "app.py"


def run(cmd: list[str]):
    print(f">> {' '.join(cmd)}")
    subprocess.check_call(cmd)


# def ensure_pip():
#     run(["python3", "-m", "ensurepip", "--user"])


def setup_venv():
    if not VENV.exists():
        run(["python3", "-m", "venv", str(VENV)])

    pip = VENV / "bin/pip"
    run([str(pip), "install", "-r", str(REQ)])


def run_app():
    python = VENV / "bin/python"
    run([str(python), str(APP), "--mode", ARGS.mode, "--task", ARGS.task])


def main():
    print("== yadm python bootstrap ==")
    # ensure_pip()
    setup_venv()
    run_app()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Genesis bootstrap")
    parser.add_argument(
        "--mode",
        choices=["system", "source"],
        default="system",
        help="Installation mode to pass to app.py (default: system)",
    )
    parser.add_argument(
        "--task",
        choices=["install", "config", "all"],
        default="all",
        help="Tasks to pass to app.py (default: all)",
    )
    ARGS = parser.parse_args()
    main()
