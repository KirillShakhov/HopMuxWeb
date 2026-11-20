import os
import tempfile
from pathlib import Path

import tomlkit


VAULT_PREFIX = "# hopmuxweb-vault = "


def split_vault_binding(raw: str) -> tuple[str | None, str]:
    first, _, rest = raw.partition("\n")
    if first.startswith(VAULT_PREFIX):
        return first[len(VAULT_PREFIX):].strip(), rest
    return None, raw


def with_vault_binding(raw: str, vault_id: str) -> str:
    return f"{VAULT_PREFIX}{vault_id}\n{split_vault_binding(raw)[1]}"


def include_paths(path: Path, document):
    includes = document.get("include", [])
    if isinstance(includes, list):
        for include in includes:
            if isinstance(include, str):
                yield (path.parent / include).resolve()


def configuration_files(directory: Path, preferred: Path) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(path for path in directory.iterdir()
                  if (path == preferred or not path.name.startswith(".") and path.suffix.lower() == ".toml")
                  and not path.is_symlink() and path.is_file())


def included_files(files: list[Path]) -> set[Path]:
    included = set()
    for path in files:
        try:
            included.update(include_paths(path, tomlkit.parse(path.read_text(encoding="utf-8"))))
        except (OSError, ValueError, RuntimeError):
            # Keep invalid profiles discoverable so they can be repaired in the editor.
            continue
    return included


def discover(directory: Path, preferred: Path) -> dict[str, Path]:
    files = configuration_files(directory, preferred)
    included = included_files(files)
    return {path.name: path for path in files if path not in included or path == preferred}


def create_configuration(directory: Path, preferred: Path, value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("Введите имя файла конфигурации")
    name = value.strip()
    if not name or name.startswith(".") or any(ch in "/\\" or not ch.isprintable() for ch in name):
        raise ValueError("Введите имя файла без пути")
    if not name.lower().endswith(".toml"):
        name += ".toml"
    if len(name.encode("utf-8")) > 255:
        raise ValueError("Имя файла слишком длинное")
    destination = directory / name
    if destination in included_files(configuration_files(directory, preferred)):
        raise FileExistsError("Имя уже используется в include другой конфигурации")
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=directory, prefix=".hopmux-new-") as draft:
        draft.write(b"[nodes]\n")
        draft.flush()
        os.link(draft.name, destination)
    return name


def vault_references(paths, entry: str):
    visited = set()
    pending = list(paths)
    while pending:
        path = pending.pop()
        if path in visited:
            continue
        visited.add(path)
        document = tomlkit.parse(path.read_text(encoding="utf-8"))
        nodes = document.get("nodes", {})
        if isinstance(nodes, dict):
            for host, settings in nodes.items():
                if isinstance(settings, dict) and settings.get("password_vault") == entry:
                    yield f"{path.name}: {host}"
        pending.extend(include_paths(path, document))
