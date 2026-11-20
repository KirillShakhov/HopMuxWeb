import json
import os
import re
import tempfile
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException

from .configurations import split_vault_binding
from .vault import COOKIE, Vault

SHARED = "shared"
SHARED_NAME = "Общее хранилище"


def cookie_name(vault_id: str) -> str:
    return COOKIE if vault_id == SHARED else f"{COOKIE}_{vault_id}"


class VaultRegistry:
    def __init__(self, directory: Path, shared: Vault):
        self.directory = directory
        self.catalog_file = directory / "catalog.json"
        self.vaults = {SHARED: shared}

    def read(self):
        try:
            value = json.loads(self.catalog_file.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"names": {}, "bindings": {}}
        except (OSError, ValueError):
            raise HTTPException(500, "Не удалось прочитать список хранилищ mssh") from None
        if not isinstance(value, dict):
            raise HTTPException(500, "Повреждён список хранилищ mssh")
        names, bindings = value.get("names"), value.get("bindings")
        if (not isinstance(names, dict) or not isinstance(bindings, dict)
                or any(not re.fullmatch(r"[0-9a-f]{32}", key) or not isinstance(name, str) for key, name in names.items())
                or any(not isinstance(vault_id, str) or vault_id not in names for vault_id in bindings.values())):
            raise HTTPException(500, "Повреждён список хранилищ mssh")
        return value

    def save(self, catalog):
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".catalog-", dir=self.directory)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as stream:
                json.dump(catalog, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.catalog_file)
        finally:
            Path(temporary).unlink(missing_ok=True)

    def selected(self, config: Path, catalog) -> str:
        try:
            with config.open(encoding="utf-8") as stream:
                first = stream.readline()
        except FileNotFoundError:
            first = ""
        except (OSError, UnicodeError):
            raise HTTPException(500, "Не удалось прочитать привязку из конфигурации") from None
        selected, _ = split_vault_binding(first)
        if selected is not None:
            return selected
        return catalog["bindings"].get(config.name, SHARED)

    def for_config(self, vault_id: str, config: Path) -> Vault:
        vault = self.vaults.get(vault_id)
        if vault is None:
            vault = Vault(self.vaults[SHARED].cli, config, self.directory / f"{vault_id}.json")
            self.vaults[vault_id] = vault
        return vault.for_config(config)

    def list(self, catalog):
        return [{"id": SHARED, "name": SHARED_NAME}] + [
            {"id": vault_id, "name": name}
            for vault_id, name in sorted(catalog["names"].items(), key=lambda item: item[1].casefold())
        ]

    async def create(self, config: Path, name: str, password: bytes, catalog):
        if any(item["name"].casefold() == name.casefold() for item in self.list(catalog)):
            raise HTTPException(409, "Хранилище с таким именем уже существует")
        vault_id = uuid4().hex
        path = self.directory / f"{vault_id}.json"
        vault = Vault(self.vaults[SHARED].cli, config, path)
        # Create the private directory before Vault.write can create an envelope in it.
        try:
            self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        except OSError:
            raise HTTPException(500, "Не удалось создать каталог хранилищ mssh") from None
        token = await vault.unlock(password, create=True)
        catalog["names"][vault_id] = name
        try:
            self.save(catalog)
        except OSError:
            path.unlink(missing_ok=True)
            raise HTTPException(500, "Не удалось сохранить список хранилищ mssh") from None
        self.vaults[vault_id] = vault
        return vault_id, token
