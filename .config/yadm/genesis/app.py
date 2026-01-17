import argparse

from rich import print

from core.installer import run_tasks


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments for install mode.

    Returns:
        Parsed argparse Namespace with the selected mode.
    """
    parser = argparse.ArgumentParser(description="Install packages for genesis")
    parser.add_argument(
        "--task",
        choices=["install", "config", "all"],
        default="all",
        help="Tasks to run (default: all)",
    )
    parser.add_argument(
        "--mode",
        choices=["system", "source"],
        default="system",
        help="Installation mode (default: system)",
    )
    return parser.parse_args()


def main() -> None:
    """Entry point for the bootstrap installer."""
    print("[bold green]Bootstrap app started[/bold green]")
    args = parse_args()
    run_tasks(args.mode, args.task)


if __name__ == "__main__":
    main()
