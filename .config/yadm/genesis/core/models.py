from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, field_validator, model_validator


class PackageVariant(BaseModel):
    """Validated per-distro package definition."""

    model_config = ConfigDict(extra="forbid")

    method: Literal["system", "cargo", "script"] = "system"
    name: Optional[str] = None
    bin: list[str] = []
    url: Optional[str] = None
    args: list[str] = []
    post: list[str] = []
    phase: int = 0
    script: Optional[str] = None

    @field_validator("args", "post", "bin", mode="before")
    @classmethod
    def _ensure_list(cls, value):
        if value is None:
            return []
        return value

    @field_validator("phase", mode="before")
    @classmethod
    def _ensure_phase(cls, value):
        if isinstance(value, int):
            return value
        return 0

    @model_validator(mode="after")
    def _validate_requirements(self) -> "PackageVariant":
        if self.method == "script" and not self.script:
            raise ValueError("script method requires script")
        return self


class PackagesConfig(BaseModel):
    """Validated packages configuration."""

    model_config = ConfigDict(extra="forbid")

    install: list[str] = []
    packages: dict[str, dict[str, PackageVariant]] = {}

    @field_validator("install", mode="before")
    @classmethod
    def _validate_install(cls, value):
        if value is None:
            return []
        return value

    @model_validator(mode="after")
    def _validate_install_entries(self) -> "PackagesConfig":
        missing = [name for name in self.install if name not in self.packages]
        if missing:
            raise ValueError(
                f"install contains undefined packages: {', '.join(missing)}"
            )
        return self


class ConfigFileEntry(BaseModel):
    """Validated config file deployment entry."""

    model_config = ConfigDict(extra="forbid")

    src: str
    dest: str
    type: Literal["file", "dir"] = "file"
    mode: Optional[str | int] = None
    owner: Optional[str] = None
    group: Optional[str] = None
    backup: bool = True
    only: list[str] = []

    @field_validator("mode", mode="before")
    @classmethod
    def _normalize_mode(cls, value):
        if value is None:
            return None
        if isinstance(value, int):
            return value
        if isinstance(value, str) and value:
            return value
        return None

    @model_validator(mode="after")
    def _validate_paths(self) -> "ConfigFileEntry":
        if not self.src.strip():
            raise ValueError("src must be non-empty")
        if not self.dest.strip():
            raise ValueError("dest must be non-empty")
        if self.type == "dir" and self.mode is not None:
            raise ValueError("mode is not supported for dir entries")
        return self

    @field_validator("only", mode="before")
    @classmethod
    def _ensure_only_list(cls, value):
        if value is None:
            return []
        return value


class ConfigManifest(BaseModel):
    """Validated manifest for config deployment."""

    model_config = ConfigDict(extra="forbid")

    files: list[ConfigFileEntry] = []

    @model_validator(mode="after")
    def _ensure_files(self) -> "ConfigManifest":
        if not self.files:
            raise ValueError("files must not be empty")
        return self
