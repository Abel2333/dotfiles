import core.installer as installer


def test_install_packages_phase_order(monkeypatch):
    monkeypatch.setattr(installer, "has_root", lambda: False)
    monkeypatch.setattr(installer, "load_package_list", lambda: ["a", "b", "c"])

    items = [
        {"method": "system", "name": "sys1", "phase": 0},
        {"method": "cargo", "name": "cargo1", "phase": 0},
        {"method": "script", "name": "script1", "phase": 1},
        {"method": "system", "name": "sys2", "phase": 1},
    ]
    monkeypatch.setattr(installer, "resolve_items", lambda pkgs: items)

    calls = []

    def fake_install_system(names, runner=None):
        calls.append(("system", names))
        return True

    def fake_install_cargo(items):
        calls.append(("cargo", [i["name"] for i in items]))

    def fake_install_script(items):
        calls.append(("script", [i["name"] for i in items]))

    def fake_run_post(items):
        calls.append(("post", [i["name"] for i in items]))

    monkeypatch.setattr(installer, "install_system", fake_install_system)
    monkeypatch.setattr(installer, "install_cargo", fake_install_cargo)
    monkeypatch.setattr(installer, "install_script", fake_install_script)
    monkeypatch.setattr(installer, "run_post", fake_run_post)

    installer.install_packages("system", runner=None)

    assert calls == [
        ("system", ["sys1"]),
        ("post", ["sys1"]),
        ("cargo", ["cargo1"]),
        ("post", ["cargo1"]),
        ("system", ["sys2"]),
        ("post", ["sys2"]),
        ("script", ["script1"]),
        ("post", ["script1"]),
    ]
