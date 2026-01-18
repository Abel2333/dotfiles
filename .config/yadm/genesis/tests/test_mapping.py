import textwrap

import core.mapping as mapping


def test_load_package_list_valid(tmp_path, monkeypatch):
    toml = textwrap.dedent(
        """
        install = ["git", "ripgrep"]

        [packages.git]
        default = { method = "system", name = "git" }

        [packages.ripgrep]
        debian = { method = "cargo", name = "ripgrep", phase = 1 }
        """
    )
    packages_file = tmp_path / "packages.toml"
    packages_file.write_text(toml)
    monkeypatch.setattr(mapping, "PACKAGES_FILE", packages_file)

    assert mapping.load_package_list() == ["git", "ripgrep"]


def test_load_package_list_invalid_missing_package(tmp_path, monkeypatch):
    toml = textwrap.dedent(
        """
        install = ["git", "missing"]

        [packages.git]
        default = { method = "system", name = "git" }
        """
    )
    packages_file = tmp_path / "packages.toml"
    packages_file.write_text(toml)
    monkeypatch.setattr(mapping, "PACKAGES_FILE", packages_file)

    assert mapping.load_package_list() == []


def test_resolve_items_selects_distro_variant(tmp_path, monkeypatch):
    toml = textwrap.dedent(
        """
        install = ["ripgrep"]

        [packages.ripgrep]
        gentoo = { method = "system", name = "sys-apps/ripgrep" }
        debian = { method = "cargo", name = "ripgrep", phase = 2 }
        """
    )
    packages_file = tmp_path / "packages.toml"
    packages_file.write_text(toml)
    monkeypatch.setattr(mapping, "PACKAGES_FILE", packages_file)
    monkeypatch.setattr(mapping, "detect_distro_ids", lambda: ["debian"])

    items = mapping.resolve_items(["ripgrep"])
    assert items == [
        {
            "method": "cargo",
            "name": "ripgrep",
            "url": None,
            "args": [],
            "post": [],
            "phase": 2,
            "script": None,
        }
    ]
