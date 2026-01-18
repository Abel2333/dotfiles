import core.system as system


class FakeRunner:
    def __init__(self):
        self.started = False
        self.commands = []

    def start(self):
        self.started = True
        return True

    def run(self, cmd):
        self.commands.append(cmd)

    def stop(self):
        pass


def test_detect_pkg_manager(monkeypatch):
    monkeypatch.setattr(system.shutil, "which", lambda name: "/bin/apt-get" if name == "apt-get" else None)
    name, cmd = system.detect_pkg_manager()
    assert name == "apt-get"
    assert cmd[:2] == ["apt-get", "install"]


def test_install_system_uses_runner(monkeypatch):
    runner = FakeRunner()
    monkeypatch.setattr(system, "detect_pkg_manager", lambda: ("apt-get", ["apt-get", "install", "-y"]))

    assert system.install_system(["git"], runner=runner)
    assert runner.started is True
    assert runner.commands == [["apt-get", "install", "-y", "git"]]


def test_install_system_no_sudo(monkeypatch):
    calls = []

    def fake_run(cmd, check=False):
        calls.append(cmd)
        return 0

    monkeypatch.setattr(system, "detect_pkg_manager", lambda: ("brew", ["brew", "install"]))
    monkeypatch.setattr(system.subprocess, "run", fake_run)

    assert system.install_system(["git"], runner=None)
    assert calls == [["brew", "install", "git"]]
