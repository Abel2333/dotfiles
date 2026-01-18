import tomllib
from pathlib import Path

from pydantic import ValidationError
from rich import print

from .models import PackageVariant, PackagesConfig

ROOT = Path(__file__).resolve().parents[1]
PACKAGES_FILE = ROOT / "packages" / "packages.toml"


def read_os_release() -> dict[str, str]:
    """Parse /etc/os-release into a key/value mapping.

    Returns:
        A dict of keys and values from /etc/os-release. Returns an empty dict
        if the file is missing.
    """
    data: dict[str, str] = {}
    path = Path("/etc/os-release")
    if not path.exists():
        return data

    for line in path.read_text().splitlines():
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key] = value.strip().strip('"')

    return data


def detect_distro_ids() -> list[str]:
    """Return distro identifiers from /etc/os-release.

    Returns:
        A list of identifiers ordered with ID first, followed by ID_LIKE entries.
    """
    data = read_os_release()
    ids: list[str] = []
    if "ID" in data:
        ids.append(data["ID"])
    if "ID_LIKE" in data:
        ids.extend(data["ID_LIKE"].split())
    return ids


def load_packages_config() -> dict[str, object]:
    """Load packages configuration from packages/packages.toml.

    Returns:
        A dict parsed from the TOML file. Returns an empty dict when the file
        is missing or invalid.
    """
    if not PACKAGES_FILE.exists():
        return {}
    try:
        return tomllib.loads(PACKAGES_FILE.read_text())
    except tomllib.TOMLDecodeError:
        print("[yellow]Invalid packages/packages.toml; ignoring[/yellow]")
        return {}


def load_package_list() -> list[str]:
    """Return the install list from packages/packages.toml.

    Returns:
        A list of package names from the install array.
    """
    data = load_packages_config()
    try:
        config = PackagesConfig.model_validate(data)
    except ValidationError:
        print("[yellow]packages.toml: invalid install list[/yellow]")
        return []
    return config.install


def load_package_map() -> dict[str, dict[str, PackageVariant]]:
    """Load package mapping data from packages/packages.toml.

    Returns:
        A dict parsed from the TOML packages table. Returns an empty dict if missing.
    """
    data = load_packages_config()
    try:
        config = PackagesConfig.model_validate(data)
    except ValidationError:
        print("[yellow]packages.toml: invalid packages table[/yellow]")
        return {}
    return config.packages

def select_mapping(entry: dict[str, PackageVariant], distro_ids: list[str]) -> PackageVariant | None:
    """Select the best mapping entry for the current distro ids.

    Args:
        entry: Raw mapping entry from the TOML file.
        distro_ids: Distro identifiers to match in priority order.

    Returns:
        The selected mapping object or None if no match exists.
    """
    for distro_id in distro_ids:
        if distro_id in entry:
            return entry[distro_id]
    return entry.get("default")


def normalize_item(name: str, mapped: PackageVariant | None) -> dict[str, object]:
    """Normalize a mapped entry into a standard item dict.

    Args:
        name: Logical package name from the base list.
        mapped: Mapping result which may be None, str, or dict.

    Returns:
        A dict with keys: method, name, url, args, post, phase.
    """
    if mapped is None:
        return {"method": "system", "name": name, "post": [], "phase": 0}
    method = mapped.method
    item_name = mapped.name or name
    url = mapped.url
    args = mapped.args
    post = mapped.post
    phase = mapped.phase
    script = mapped.script
    return {
        "method": method,
        "name": item_name,
        "url": url,
        "args": args,
        "post": post,
        "phase": phase,
        "script": script,
    }


def resolve_items(pkgs: list[str]) -> list[dict[str, object]]:
    """Resolve package entries into per-distro install items.

    Args:
        pkgs: Logical package names from base.txt.

    Returns:
        A list of normalized install items with method-specific fields.
    """
    mapping = load_package_map()
    distro_ids = detect_distro_ids()
    resolved: list[dict[str, object]] = []
    for name in pkgs:
        entry = mapping.get(name)
        mapped = select_mapping(entry, distro_ids) if entry is not None else None
        resolved.append(normalize_item(name, mapped))
    return resolved
