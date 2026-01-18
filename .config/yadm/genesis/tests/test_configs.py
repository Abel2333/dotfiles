import core.configs as configs


class DummyRunner:
    def __init__(self):
        self.commands = []
        self.started = False

    def start(self):
        self.started = True
        return True

    def run(self, cmd):
        self.commands.append(cmd)

    def stop(self):
        pass


def test_deploy_configs_file(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    configs_dir.mkdir()
    src = configs_dir / "keyd.conf"
    src.write_text("test")
    dest = tmp_path / "etc" / "keyd.conf"

    manifest = (
        """
[[files]]
src = "keyd.conf"
dest = "%s"
mode = "0644"
backup = false
"""
        % dest
    )
    (configs_dir / "manifest.toml").write_text(manifest)

    monkeypatch.setattr(configs, "CONFIGS_DIR", configs_dir)
    monkeypatch.setattr(configs, "MANIFEST_FILE", configs_dir / "manifest.toml")

    configs.deploy_configs(runner=None)

    assert dest.read_text() == "test"


def test_deploy_configs_dir_gentoo_only(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    src_dir = configs_dir / "portage"
    src_dir.mkdir(parents=True)
    (src_dir / "make.conf").write_text("DATA")
    dest_dir = tmp_path / "etc" / "portage"

    manifest = (
        """
[[files]]
type = "dir"
src = "portage"
dest = "%s"
only = ["gentoo"]
backup = false
"""
        % dest_dir
    )
    (configs_dir / "manifest.toml").write_text(manifest)

    monkeypatch.setattr(configs, "CONFIGS_DIR", configs_dir)
    monkeypatch.setattr(configs, "MANIFEST_FILE", configs_dir / "manifest.toml")
    monkeypatch.setattr(configs, "detect_distro_ids", lambda: ["gentoo"])

    runner = DummyRunner()
    configs.deploy_configs(runner=runner)

    assert runner.commands
    assert runner.commands[0][0] == "rsync"


def test_deploy_configs_dir_skipped_on_other_distro(tmp_path, monkeypatch):
    configs_dir = tmp_path / "configs"
    src_dir = configs_dir / "portage"
    src_dir.mkdir(parents=True)
    (src_dir / "make.conf").write_text("DATA")
    dest_dir = tmp_path / "etc" / "portage"

    manifest = (
        """
[[files]]
type = "dir"
src = "portage"
dest = "%s"
only = ["gentoo"]
backup = false
"""
        % dest_dir
    )
    (configs_dir / "manifest.toml").write_text(manifest)

    monkeypatch.setattr(configs, "CONFIGS_DIR", configs_dir)
    monkeypatch.setattr(configs, "MANIFEST_FILE", configs_dir / "manifest.toml")
    monkeypatch.setattr(configs, "detect_distro_ids", lambda: ["debian"])

    calls = []

    def fake_run(cmd, check=False):
        _ = check
        calls.append(cmd)
        return 0

    monkeypatch.setattr(configs.subprocess, "run", fake_run)
    configs.deploy_configs(runner=None)

    assert calls == []
