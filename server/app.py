import asyncio
import hashlib
import hmac
import json
import logging
import os
import pty
import re
import shutil
import signal
import struct
import tempfile
import time
import uuid
import fcntl
import termios
from collections import deque
from contextvars import ContextVar
from pathlib import Path
from typing import Any

import tomlkit
from fastapi import FastAPI, File, Header, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .configurations import create_configuration, discover, split_vault_binding, vault_references, with_vault_binding
from .vault import LEASE_SECONDS, Vault, VaultAccess, master_password, spawn_cli
from .vaults import SHARED, VaultRegistry, cookie_name

CONFIG_LOCATION = Path(os.getenv("HOPMUX_CONFIG", "/config/config.toml")).absolute()
CONFIG_DIR = (CONFIG_LOCATION if CONFIG_LOCATION.is_dir() else CONFIG_LOCATION.parent).resolve()
DEFAULT_CONFIG = CONFIG_DIR / ("config.toml" if CONFIG_LOCATION.is_dir() else CONFIG_LOCATION.name)
active_config = ContextVar("active_config", default=DEFAULT_CONFIG)
DATA = Path(os.getenv("HOPMUX_DATA", "/data"))
FILES = Path(os.getenv("HOPMUX_FILES", "/files"))
TOKEN = os.getenv("HOPMUX_TOKEN", "")
CLI = os.getenv("HOPMUX_CLI", "mssh")
TERMINAL_CLI = os.getenv("HOPMUX_TERMINAL_CLI", CLI)
COOKIE = "hopmux_session"
HOST_FINGERPRINT = re.compile(r"SHA256:[A-Za-z0-9+/]{43}")
REDACTED = "__HOPMUX_REDACTED__"  # accepted only for migration from older browser drafts
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
sessions: dict[str, "TerminalSession"] = {}
transfers: dict[str, dict[str, Any]] = {}
transfer_processes: dict[str, asyncio.subprocess.Process] = {}
config_lock = asyncio.Lock()
HISTORY = DATA / "transfers.json"
vaults = VaultRegistry(CONFIG_DIR / ".hopmux-vaults", Vault(
    CLI, DEFAULT_CONFIG, Path(os.environ["HOPMUX_VAULT_FILE"]) if os.getenv("HOPMUX_VAULT_FILE") else None,
))


def config_profiles():
    return discover(CONFIG_DIR, DEFAULT_CONFIG)


def default_config(profiles):
    return profiles.get(DEFAULT_CONFIG.name) or next(iter(profiles.values()), DEFAULT_CONFIG)


def save_history():
    DATA.mkdir(parents=True, exist_ok=True)
    temp = HISTORY.with_suffix(".new")
    temp.write_text(json.dumps([transfer_public(item) for item in transfers.values()][-200:]), encoding="utf-8")
    os.replace(temp, HISTORY)


@app.on_event("startup")
async def load_history():
    if HISTORY.exists():
        try:
            for item in json.loads(HISTORY.read_text(encoding="utf-8")):
                if item["state"] in ("running", "queued"):
                    item["state"] = "interrupted"
                item["logs"] = deque(item.get("logs", []), maxlen=100)
                transfers[item["id"]] = item
        except (OSError, ValueError, KeyError):
            pass


def error(message: str, status: int = 400):
    raise HTTPException(status, message)


def session_value() -> str:
    return hmac.new(TOKEN.encode(), b"hopmuxweb-session-v1", hashlib.sha256).hexdigest()


def authenticated(request: Request) -> bool:
    return bool(TOKEN) and hmac.compare_digest(request.cookies.get(COOKIE, ""), session_value())


def same_origin(headers) -> bool:
    origin = headers.get("origin")
    if not origin:
        return True
    host = headers.get("host", "")
    return origin in (f"http://{host}", f"https://{host}")


@app.middleware("http")
async def guard(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path not in ("/api/login", "/api/auth"):
        if not authenticated(request):
            return JSONResponse({"detail": "Войдите в HopMuxWeb"}, status_code=401)
        if request.method not in ("GET", "HEAD") and not same_origin(request.headers):
            return JSONResponse({"detail": "Invalid origin"}, status_code=403)
        if path not in ("/api/configurations", "/api/logout"):
            profiles = config_profiles()
            selected = request.query_params.get("config")
            config = profiles.get(selected) if selected is not None else default_config(profiles)
            if config is None:
                return JSONResponse({"detail": "Конфигурация не найдена"}, status_code=404)
            scope = active_config.set(config)
            try:
                return await call_next(request)
            finally:
                active_config.reset(scope)
    return await call_next(request)


@app.post("/api/login")
async def login(request: Request):
    if not TOKEN:
        error("HOPMUX_TOKEN не задан", 503)
    if not same_origin(request.headers):
        error("Invalid origin", 403)
    body = await request.json()
    if not hmac.compare_digest(str(body.get("token", "")), TOKEN):
        error("Неверный токен", 401)
    response = JSONResponse({"ok": True})
    response.set_cookie(COOKIE, session_value(), httponly=True, secure=request.url.scheme == "https", samesite="strict", path="/")
    return response


@app.get("/api/auth")
async def auth(request: Request):
    return {"authenticated": authenticated(request), "configured": bool(TOKEN)}


@app.post("/api/logout")
async def logout(request: Request):
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE, path="/")
    for vault_id, vault in vaults.vaults.items():
        cookie = cookie_name(vault_id)
        if cookie in request.cookies:
            vault.leases.pop(request.cookies[cookie], None)
            response.delete_cookie(cookie, path="/")
    return response


def config_text() -> str:
    try:
        return active_config.get().read_text(encoding="utf-8")
    except OSError as exc:
        error(f"Не удалось прочитать конфиг: {exc}", 500)


def config_version(raw: str) -> str:
    return hashlib.sha256(split_vault_binding(raw)[1].encode()).hexdigest()


def redact_document(raw: str) -> str:
    doc = tomlkit.parse(split_vault_binding(raw)[1])
    for node in doc.get("nodes", {}).values():
        if "password" in node:
            node.pop("password")
    return tomlkit.dumps(doc)


def restore_secrets(candidate: str, original: str, operations: dict | None = None) -> str:
    operations = operations or {}
    try:
        new = tomlkit.parse(split_vault_binding(candidate)[1])
    except Exception as exc:
        error(f"Ошибка TOML: {exc}")
    try:
        old = tomlkit.parse(original)
    except Exception:
        if re.search(r"\bpassword\s*=", original):
            error("Исходный TOML содержит пароль и ошибку синтаксиса; исправьте файл вручную")
        old = {}
    for name, node in new.get("nodes", {}).items():
        old_node = old.get("nodes", {}).get(name, {})
        operation = operations.get(name, {"action": "keep"})
        action = operation.get("action", "keep") if isinstance(operation, dict) else "invalid"
        if action not in ("keep", "replace", "remove"):
            error(f"Недопустимое действие с паролем узла {name}")
        if "password" in node:
            if node["password"] != REDACTED:
                error(f"Пароль узла {name} изменяется через отдельное поле секрета")
            node.pop("password")
        if action == "keep" and "password" in old_node:
            # Reinsert the value without the formatting of its old TOML location.
            password = old_node["password"]
            node["password"] = password.unwrap() if isinstance(password, tomlkit.items.Item) else password
        elif action == "replace":
            value = operation.get("value")
            if not isinstance(value, str) or not value:
                error(f"Введите новый пароль узла {name}")
            node["password"] = value
    text = tomlkit.dumps(new)
    vault_id, _ = split_vault_binding(original)
    return with_vault_binding(text, vault_id) if vault_id is not None else text


def route_model(document) -> list[dict[str, Any]]:
    nodes = document.get("nodes", {})
    direct = list(document.get("direct_hosts", []))
    paths = [list(p) for p in document.get("paths", [])]
    if direct or paths:
        edges: dict[str, dict[str, int]] = {}
        for priority, path in enumerate(paths):
            for a, b in zip(path, path[1:]):
                edges.setdefault(a, {})[b] = min(edges.get(a, {}).get(b, priority), priority)
        candidates: dict[str, dict[tuple[str, ...], tuple[tuple[int, ...], int]]] = {}
        def walk(chain: list[str], priorities: list[int], root_rank: int):
            if sum(map(len, candidates.values())) >= 4096:
                return
            current = chain[-1]
            key = tuple(chain)
            score = (tuple(priorities), root_rank)
            found = candidates.setdefault(current, {})
            if key not in found or score < found[key]:
                found[key] = score
            for next_id, rank in sorted(edges.get(current, {}).items(), key=lambda item: (item[1], item[0])):
                if next_id not in chain:
                    walk(chain + [next_id], priorities + [rank], root_rank)
        for i, host in enumerate(direct):
            walk([host], [], i)
        result = []
        for target, choices in sorted(candidates.items()):
            for i, (hops, _) in enumerate(sorted(choices.items(), key=lambda item: (item[1][0], item[1][1], item[0]))):
                result.append({"name": f"{target}-{i + 1}", "target": target, "hops": list(hops), "disabled": False})
        return result
    routes = [dict(r) for r in document.get("routes", [])]
    for name in nodes:
        if not any(r.get("target") == name for r in routes):
            routes.append({"name": f"direct:{name}", "target": name, "hops": [name], "disabled": False})
    return routes


def public_model(raw: str):
    version = config_version(raw)
    raw = split_vault_binding(raw)[1]
    try:
        doc = tomlkit.parse(raw)
    except Exception as exc:
        contains_password = bool(re.search(r"\bpassword\s*=", raw))
        safe_text = "# TOML содержит пароль и ошибку синтаксиса. Исправьте файл на сервере.\n" if contains_password else raw
        parse_error = "Ошибка TOML рядом с секретом. Исправьте файл на сервере." if contains_password else str(exc)
        return {"nodes": {}, "direct_hosts": [], "paths": [], "routes": [], "legacy": False, "text": safe_text, "version": version, "parse_error": parse_error}
    nodes = {}
    for name, node in doc.get("nodes", {}).items():
        nodes[name] = {key: value for key, value in dict(node).items() if key != "password"}
        nodes[name]["has_inline_password"] = "password" in node
    return {"nodes": nodes, "direct_hosts": list(doc.get("direct_hosts", [])), "paths": [list(p) for p in doc.get("paths", [])], "routes": route_model(doc), "legacy": not bool(doc.get("direct_hosts", []) or doc.get("paths", [])), "text": redact_document(raw), "version": version}


async def cli_run(*args: str, timeout: int = 30, input_text: str | None = None, access: VaultAccess | Path | None = None):
    process = await spawn_cli(CLI, args, vault=access, stdin=asyncio.subprocess.PIPE if input_text is not None else asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(process.communicate(input_text.encode() if input_text else None), timeout)
    except asyncio.TimeoutError:
        process.kill()
        await process.wait()
        error("Превышено время ожидания CLI", 504)
    return process.returncode, out.decode(errors="replace"), err.decode(errors="replace")


async def validate_config(candidate: str):
    try:
        tomlkit.parse(candidate)
    except Exception as exc:
        error(f"Ошибка TOML: {exc}")
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".hopmux-check-", suffix=".toml", dir=CONFIG_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(candidate)
        code, out, err = await cli_run("--config", temp_name, "config", "check")
        if code:
            error((err or out).strip() or "Конфигурация отклонена CLI")
        return out.strip()
    finally:
        Path(temp_name).unlink(missing_ok=True)


@app.get("/api/configurations")
async def list_configurations():
    profiles = config_profiles()
    return {"files": list(profiles), "default": default_config(profiles).name, "legacy": DEFAULT_CONFIG.name}


@app.post("/api/configurations", status_code=201)
async def add_configuration(request: Request):
    try:
        body = await request.json()
        async with config_lock:
            name = create_configuration(CONFIG_DIR, DEFAULT_CONFIG, body.get("name") if isinstance(body, dict) else None)
            return {"name": name, "catalog": await list_configurations()}
    except ValueError as exc:
        error(str(exc) if not isinstance(exc, (UnicodeError, json.JSONDecodeError)) else "Введите корректное имя файла")
    except FileExistsError as exc:
        error(str(exc) if exc.errno is None else "Файл конфигурации с таким именем уже существует", 409)
    except PermissionError:
        error("Нет доступа на запись в каталог конфигураций", 403)
    except OSError:
        error("Не удалось записать файл конфигурации", 500)


@app.get("/api/config")
async def get_config():
    try:
        return public_model(config_text())
    except Exception as exc:
        error(f"Ошибка чтения TOML: {exc}", 500)


@app.post("/api/config/check")
async def check_config(request: Request):
    body = await request.json()
    candidate = restore_secrets(body.get("text", ""), config_text(), body.get("secret_operations"))
    return {"message": await validate_config(candidate)}


@app.post("/api/config/preview")
async def preview_config(request: Request):
    body = await request.json()
    candidate = body.get("text", "")
    if not isinstance(candidate, str):
        error("Требуется текст TOML")
    original = config_text()
    try:
        candidate = restore_secrets(candidate, original, body.get("secret_operations"))
    except HTTPException as exc:
        if "Ошибка TOML" not in str(exc.detail):
            raise
        result = public_model(body["text"])
        result["version"] = config_version(original)
        return result
    result = public_model(candidate)
    result["version"] = config_version(original)
    return result


def compose_visual(raw: str, incoming: dict, legacy: bool) -> str:
    try:
        doc = tomlkit.parse(raw)
    except Exception as exc:
        error(f"Ошибка TOML: {exc}")
    if doc.get("include"):
        error("Visual-редактор не меняет конфигурации с include; используйте Raw TOML")
    if not isinstance(incoming, dict) or not isinstance(incoming.get("nodes"), dict):
        error("Требуется список узлов")
    table = tomlkit.table()
    for name, values in incoming["nodes"].items():
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            error(f"Недопустимый alias: {name}")
        if not isinstance(values, dict):
            error(f"Недопустимые поля узла {name}")
        node = tomlkit.table()
        for key, value in values.items():
            if key in ("has_inline_password", "secret_state"):
                continue
            if key == "password":
                error("Пароль изменяется через отдельное поле секрета")
            if value is not None and value != "":
                node[key] = value
        table[name] = node
    doc["nodes"] = table
    if legacy:
        doc.pop("direct_hosts", None)
        doc.pop("paths", None)
        route_items = tomlkit.aot()
        for item in incoming.get("routes", []):
            route = tomlkit.table()
            for key in ("name", "target", "hops", "priority", "disabled", "addresses"):
                if key in item:
                    route[key] = item[key]
            route_items.append(route)
        doc["routes"] = route_items
    else:
        doc.pop("routes", None)
        doc["direct_hosts"] = incoming.get("direct_hosts", [])
        doc["paths"] = incoming.get("paths", [])
    return tomlkit.dumps(doc)


@app.post("/api/config/compose")
async def compose_config(request: Request):
    body = await request.json()
    original = config_text()
    candidate = compose_visual(body.get("text", ""), body.get("model", {}), bool(body.get("legacy")))
    candidate = restore_secrets(candidate, original, body.get("secret_operations"))
    result = public_model(candidate)
    if result.get("parse_error"):
        error(result["parse_error"])
    result["version"] = config_version(original)
    return result


def write_config(candidate: str, *, config: Path | None = None, backup: bool = True):
    config = config or active_config.get()
    mode = config.stat().st_mode & 0o777
    if backup:
        shutil.copy2(config, config.with_suffix(config.suffix + ".bak"))
    fd, temporary = tempfile.mkstemp(prefix=".hopmux-write-", dir=config.parent)
    tmp = Path(temporary)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(candidate)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, config)
    finally:
        tmp.unlink(missing_ok=True)


@app.on_event("startup")
async def migrate_vault_bindings():
    try:
        async with config_lock:
            catalog = vaults.read()
            if not catalog["bindings"]:
                return
            profiles = config_profiles()
            for name, vault_id in list(catalog["bindings"].items()):
                config = profiles.get(name)
                if config is None:
                    continue
                raw = config.read_text(encoding="utf-8")
                if split_vault_binding(raw)[0] is None:
                    write_config(with_vault_binding(raw, vault_id), config=config, backup=False)
                del catalog["bindings"][name]
            vaults.save(catalog)
    except (HTTPException, OSError, UnicodeError):
        logging.getLogger(__name__).warning("Could not migrate legacy vault bindings into TOML")


@app.put("/api/config")
async def put_config(request: Request):
    body = await request.json()
    async with config_lock:
        original = config_text()
        if config_version(original) != body.get("version"):
            error("Конфигурация изменилась на диске. Обновите страницу перед сохранением.", 409)
        candidate = restore_secrets(body.get("text", ""), original, body.get("secret_operations"))
        await validate_config(candidate)
        write_config(candidate)
        return public_model(candidate)


@app.put("/api/config/visual")
async def put_visual(request: Request):
    body = await request.json()
    async with config_lock:
        original = config_text()
        if config_version(original) != body.get("version"):
            error("Конфигурация изменилась на диске", 409)
        candidate = compose_visual(original, body.get("model", {}), bool(body.get("legacy")))
        candidate = restore_secrets(candidate, original, body.get("secret_operations"))
        await validate_config(candidate)
        write_config(candidate)
        return public_model(candidate)


@app.get("/api/health")
async def health():
    return {"ok": True, "cli": CLI, "config_exists": active_config.get().exists()}


def selected_routes(model, target: str, route: str = ""):
    return [item for item in model["routes"]
            if item["target"] == target and not item.get("disabled") and (not route or item["name"] == route)]


def expected_vault(request: Request, catalog):
    vault_id = vaults.selected(active_config.get(), catalog)
    expected = request.query_params.get("vault")
    if expected is not None and expected != vault_id:
        error("Привязка хранилища изменилась. Обновите страницу", 409)
    return vault_id


def bound_vault(request: Request):
    catalog = vaults.read()
    vault_id = expected_vault(request, catalog)
    if vault_id != SHARED and vault_id not in catalog["names"]:
        error("Назначенное хранилище недоступно. Выберите другое в конфигурации", 409)
    return vault_id, vaults.for_config(vault_id, active_config.get())


def vault_access(request: Request, model, *endpoints: tuple[str, str], binding=None):
    vault_id, vault = binding or bound_vault(request)
    token = request.cookies.get(cookie_name(vault_id))
    access = None
    for target, route in endpoints:
        entries = [
            {name for hop in item["hops"] if (name := model["nodes"].get(hop, {}).get("password_vault"))}
            for item in selected_routes(model, target, route)
        ]
        lease = vault.access(token, entries)
        if lease is not None:
            access = lease
    return access if access is not None else vault.path()


def vault_selection(request: Request, catalog, token=None):
    config = active_config.get()
    vault_id = vaults.selected(config, catalog)
    status = {"exists": False, "unlocked": False, "entries": []}
    if vault_id == SHARED or vault_id in catalog["names"]:
        vault = vaults.for_config(vault_id, config)
        status = vault.status(token or request.cookies.get(cookie_name(vault_id)))
    return {"selected": vault_id, "vaults": vaults.list(catalog), "status": status}


def vault_cookie_response(request: Request, vault_id: str, token: str, data, status_code=200):
    response = JSONResponse(data, status_code=status_code, headers={"Cache-Control": "no-store"})
    response.set_cookie(cookie_name(vault_id), token, max_age=LEASE_SECONDS, httponly=True,
                        secure=request.url.scheme == "https", samesite="strict", path="/")
    return response


@app.get("/api/vaults")
async def list_vaults(request: Request):
    return JSONResponse(vault_selection(request, vaults.read()), headers={"Cache-Control": "no-store"})


def save_vault_binding(vault_id: str):
    try:
        write_config(with_vault_binding(config_text(), vault_id), backup=False)
    except PermissionError:
        error("Нет доступа на запись в файл конфигурации", 403)
    except OSError:
        error("Не удалось записать привязку в файл конфигурации", 500)


@app.put("/api/vault/binding")
async def bind_vault(request: Request):
    body = await request.json()
    vault_id = body.get("id") if isinstance(body, dict) else None
    if not isinstance(vault_id, str):
        error("Выберите хранилище")
    async with config_lock:
        catalog = vaults.read()
        expected_vault(request, catalog)
        if vault_id != SHARED and vault_id not in catalog["names"]:
            error("Хранилище не найдено", 404)
        save_vault_binding(vault_id)
        return JSONResponse(vault_selection(request, catalog), headers={"Cache-Control": "no-store"})


@app.post("/api/vaults", status_code=201)
async def create_named_vault(request: Request):
    body = await request.json()
    name = body.get("name") if isinstance(body, dict) else None
    if not isinstance(name, str) or not name.strip() or not name.strip().isprintable():
        error("Введите имя хранилища")
    password = master_password(body.get("password"))
    if body.get("password") != body.get("confirmation"):
        error("Мастер-пароли не совпадают")
    async with config_lock:
        catalog = vaults.read()
        expected_vault(request, catalog)
        vault_id, token = await vaults.create(active_config.get(), name.strip(), password, catalog)
        try:
            save_vault_binding(vault_id)
        except HTTPException as exc:
            error(f"Хранилище создано. {exc.detail}", exc.status_code)
        return vault_cookie_response(request, vault_id, token, vault_selection(request, catalog, token), status_code=201)


@app.get("/api/vault")
async def vault_status(request: Request):
    vault_id, vault = bound_vault(request)
    return JSONResponse(vault.status(request.cookies.get(cookie_name(vault_id))), headers={"Cache-Control": "no-store"})


async def open_vault(request: Request, *, create=False):
    body = await request.json()
    password = master_password(body.get("password"))
    if create and body.get("password") != body.get("confirmation"):
        error("Мастер-пароли не совпадают")
    vault_id, vault = bound_vault(request)
    token = await vault.unlock(password, create=create)
    vault.leases.pop(request.cookies.get(cookie_name(vault_id)), None)
    return vault_cookie_response(request, vault_id, token, vault.status(token))


@app.post("/api/vault/create")
async def create_vault(request: Request):
    return await open_vault(request, create=True)


@app.post("/api/vault/unlock")
async def unlock_vault(request: Request):
    return await open_vault(request)


@app.post("/api/vault/lock")
async def lock_vault(request: Request):
    vault_id, vault = bound_vault(request)
    cookie = cookie_name(vault_id)
    vault.leases.pop(request.cookies.get(cookie), None)
    response = JSONResponse(vault.status(None), headers={"Cache-Control": "no-store"})
    response.delete_cookie(cookie)
    return response


def entry_name(value):
    if not isinstance(value, str) or not value:
        error("Введите имя записи")
    return value


@app.put("/api/vault/entries")
async def save_vault_entry(request: Request):
    body = await request.json()
    name = entry_name(body.get("name"))
    password = body.get("password")
    if not isinstance(password, str) or not password:
        error("Введите пароль для записи")

    def update(entries):
        if name in entries and body.get("replace") is not True:
            error("Запись с таким именем уже существует", 409)
        if name not in entries and body.get("replace") is True:
            error("Запись не найдена", 404)
        entries[name] = password

    vault_id, vault = bound_vault(request)
    return await vault.change(request.cookies.get(cookie_name(vault_id)), update)


@app.delete("/api/vault/entries")
async def delete_vault_entry(request: Request):
    name = entry_name((await request.json()).get("name"))

    def update(entries):
        if name not in entries:
            error("Запись не найдена", 404)
        try:
            catalog = vaults.read()
            configs = [path for path in config_profiles().values() if vaults.selected(path, catalog) == vault_id]
            used_by = list(vault_references(configs, name))
        except (OSError, ValueError, RuntimeError):
            error("Не удалось проверить ссылки на запись во всех конфигурациях", 409)
        if used_by:
            error("Запись используется хостами: " + ", ".join(used_by), 409)
        del entries[name]

    async with config_lock:
        vault_id, vault = bound_vault(request)
        return await vault.change(request.cookies.get(cookie_name(vault_id)), update)


@app.post("/api/vault/rotate")
async def rotate_vault_password(request: Request):
    body = await request.json()
    password = master_password(body.get("password"))
    if body.get("password") != body.get("confirmation"):
        error("Мастер-пароли не совпадают")
    vault_id, vault = bound_vault(request)
    return await vault.change(request.cookies.get(cookie_name(vault_id)), lambda entries: None, password=password)


@app.get("/api/vault/backup")
async def encrypted_vault_backup(request: Request):
    vault_id, vault = bound_vault(request)
    encrypted = vault.read(vault.path())
    if vault.lease(request.cookies.get(cookie_name(vault_id)), encrypted) is None:
        error("Разблокируйте хранилище mssh", 423)
    filename = vault.file.name if vault_id != SHARED and vault.file else "vault.json"
    return Response(encrypted, media_type="application/json", headers={
        "Cache-Control": "no-store", "Content-Disposition": f'attachment; filename="{filename}"',
    })


@app.post("/api/probe/{target}")
async def probe(target: str, request: Request):
    model = public_model(config_text())
    if target not in model["nodes"]:
        error("Неизвестный хост", 404)
    access = vault_access(request, model, (target, ""))
    code, out, err = await cli_run("--config", str(active_config.get()), "--json", "status", target, timeout=90, access=access)
    if not out.strip():
        error(err.strip() or "Нет ответа от CLI", 502)
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        error(err.strip() or out.strip(), 502)


def local_path(relative: str, must_exist: bool = False) -> Path:
    if not isinstance(relative, str) or not relative or "\0" in relative or Path(relative).is_absolute():
        error("Используйте относительный путь внутри /files")
    root = FILES.resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root) or (must_exist and not path.exists()):
        error("Путь вне разрешённой директории или не существует")
    return path


@app.get("/api/files")
async def files(path: str = "."):
    directory = local_path(path, True)
    if not directory.is_dir():
        error("Это не директория")
    return {"path": directory.relative_to(FILES.resolve()).as_posix(), "entries": [{"name": p.name, "directory": p.is_dir(), "size": p.stat().st_size if p.is_file() else None} for p in sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())) if not p.is_symlink()]}


@app.get("/api/files/remote")
async def remote_files(request: Request, host: str, route: str = "", path: str = "."):
    if path != "." and (not path.startswith("/") or "\0" in path):
        error("Укажите абсолютный путь к каталогу на хосте")
    model = public_model(config_text())
    if not selected_routes(model, host, route):
        error("Неизвестный хост или маршрут")
    access = vault_access(request, model, (host, route))
    args = ["--config", str(active_config.get())]
    if route:
        args += ["--route", route]
    code, out, stderr = await cli_run(*args, "--", "ls", host, path, timeout=45, access=access)
    if code:
        error(stderr.strip().splitlines()[-1] if stderr.strip() else "Не удалось открыть удалённый каталог", 502)
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        error("mssh не вернул список файлов", 502)


@app.post("/api/files/upload")
async def browser_upload(file: UploadFile = File(...), path: str = "."):
    safe_name = Path(file.filename or "").name
    if not safe_name or safe_name in (".", ".."):
        error("Неверное имя файла")
    directory = local_path(path, True)
    if not directory.is_dir():
        error("Это не директория")
    target = local_path(str(directory.relative_to(FILES.resolve()) / safe_name))
    try:
        output = target.open("xb")
    except FileExistsError:
        error("Файл уже существует", 409)
    except PermissionError:
        error("Нет доступа к записи в каталог /files", 403)
    try:
        with output:
            while data := await file.read(1024 * 1024):
                output.write(data)
    except (OSError, asyncio.CancelledError):
        target.unlink(missing_ok=True)
        raise
    return {"path": target.relative_to(FILES.resolve()).as_posix()}


@app.get("/api/files/download")
async def browser_download(path: str):
    target = local_path(path, True)
    if not target.is_file():
        error("Это не файл")
    return FileResponse(target, filename=target.name)


def terminal_route_hosts(model, target, route):
    selected = [item for item in model["routes"]
                if item["target"] == target and not item.get("disabled") and (not route or item["name"] == route)]
    return {hop for item in selected for hop in item["hops"] if hop in model["nodes"]}


class TerminalSession:
    def __init__(self, target: str, route: str, warnings: list[dict[str, Any]], vault_id: str):
        self.id = uuid.uuid4().hex
        self.config = active_config.get()
        self.vault_id = vault_id
        self.target = target
        self.route = route
        self.state = "connecting"
        self.error = ""
        self.warnings = {item["node"]: item for item in warnings}
        self.host_keys: dict[tuple[str, str], dict[str, Any]] = {}
        self.updated_keys: dict[str, str] = {}
        self.reload_config = False
        self.reconnect_lock = asyncio.Lock()
        self.active_route = route
        self.created = time.time()
        self.master = -1
        self.process = None
        self.terminating = False
        self.clients: set[WebSocket] = set()
        self.writer: WebSocket | None = None
        self.history = deque(maxlen=512)
        self.output_lock = asyncio.Lock()
        self.stderr_task = None
        self.reader_task = None

    async def broadcast(self, message: dict):
        for client in list(self.clients):
            try:
                await client.send_json(message)
            except Exception:
                self.clients.discard(client)

    async def set_state(self, state: str, error_text: str = ""):
        if self.state == state and self.error == error_text:
            return
        self.state = state
        self.error = error_text
        await self.broadcast({"type": "state", **self.summary()})

    async def emit_output(self, data: bytes):
        async with self.output_lock:
            self.history.append(data)
            for client in list(self.clients):
                try:
                    await client.send_bytes(data)
                except Exception:
                    self.clients.discard(client)

    async def start(self, access: VaultAccess | Path | None = None):
        master, slave = pty.openpty()
        self.master = master
        self.terminating = False
        await self.set_state("connecting")
        args = [TERMINAL_CLI, "--debug", "--config", str(self.config)]
        if self.route:
            args += ["--route", self.route]
        args.append(self.target)
        try:
            self.process = await spawn_cli(args[0], args[1:], vault=access, stdin=slave, stdout=slave, stderr=asyncio.subprocess.PIPE, start_new_session=True)
        except Exception:
            os.close(master)
            os.close(slave)
            self.master = -1
            raise
        os.close(slave)
        self.stderr_task = asyncio.create_task(self.read_stderr())
        self.reader_task = asyncio.create_task(self.read_loop())

    async def stop(self):
        process = self.process
        if process and process.returncode is None:
            self.terminating = True
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(process.wait(), 3)
            except TimeoutError:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
        if self.reader_task:
            await asyncio.shield(self.reader_task)

    async def observe_host_key(self, payload: str):
        try:
            observed = json.loads(payload)
        except ValueError:
            return
        if not isinstance(observed, dict):
            return
        fields = ("node", "route", "route_path", "host", "fingerprint")
        if any(not isinstance(observed.get(field), str) for field in fields):
            return
        expected = observed.get("expected")
        if not HOST_FINGERPRINT.fullmatch(observed["fingerprint"]) or (
            expected is not None and (not isinstance(expected, str) or not HOST_FINGERPRINT.fullmatch(expected))
        ):
            return
        if not isinstance(observed.get("port"), int):
            return
        observed["expected"] = expected
        node = observed["node"]
        key = (node, observed["route_path"])
        current = self.host_keys.get(key)
        if not current or any(current.get(field) != observed.get(field) for field in (*fields, "expected", "port")):
            observed["id"] = uuid.uuid4().hex
            self.host_keys[key] = observed
            self.warnings.pop(node, None)
            await self.broadcast({"type": "host_keys", "warnings": self.host_key_warnings()})

    def host_key_warnings(self):
        warnings = list(self.warnings.values())
        for observed in self.host_keys.values():
            expected = self.updated_keys.get(observed["node"], observed["expected"])
            if expected != observed["fingerprint"]:
                warnings.append({**observed, "expected": expected, "kind": "mismatch" if expected else "unpinned"})
        return warnings

    async def read_stderr(self):
        while line := await self.process.stderr.readline():
            message = line.decode(errors="replace").strip()
            if message.startswith("[debug "):
                if "SSH shell: trying route" in message:
                    await self.set_state("connecting")
                elif "] SSH host key observation " in message:
                    await self.observe_host_key(message.split("] SSH host key observation ", 1)[1])
                elif "SSH host key on " in message:
                    await self.set_state("verifying_host_key")
                    if "rejected" in message:
                        match = re.search(r" at ([^: ]+): rejected", message)
                        if match:
                            node = match.group(1)
                            if not any(item["node"] == node and item["kind"] == "mismatch" for item in self.host_key_warnings()):
                                self.warnings[node] = {"node": node, "kind": "rejected", "fingerprint": None}
                                await self.broadcast({"type": "host_keys", "warnings": self.host_key_warnings()})
                elif route := re.search(r"SSH shell: (?:attached|opening terminal) via (.+)", message):
                    self.active_route = route[1]
                    await self.set_state("connected")
                elif "SSH shell:" in message and "disconnected" in message:
                    await self.set_state("disconnected")
                continue
            if message.startswith("warning: SSH host keys are not verified"):
                continue
            if message.startswith("mssh:"):
                self.error = message
            await self.emit_output(line)

    async def read_loop(self):
        loop = asyncio.get_running_loop()
        try:
            while True:
                try:
                    data = await loop.run_in_executor(None, os.read, self.master, 65536)
                except OSError:
                    break
                if not data:
                    break
                await self.emit_output(data)
            await self.process.wait()
            if self.stderr_task:
                await self.stderr_task
            if self.terminating:
                await self.set_state("exited")
            else:
                await self.set_state("exited" if self.process.returncode == 0 else "error", self.error or (f"CLI завершился с кодом {self.process.returncode}" if self.process.returncode else ""))
        finally:
            os.close(self.master)
            self.master = -1

    def summary(self):
        running = self.process is not None and self.process.returncode is None
        return {"id": self.id, "target": self.target, "route": self.route, "active_route": self.active_route, "state": self.state, "running": running, "error": self.error, "warnings": self.host_key_warnings(), "created": self.created}


@app.get("/api/sessions")
async def list_sessions():
    return [session.summary() for session in sessions.values() if session.config == active_config.get()]


@app.get("/api/sessions/{session_id}")
async def get_session(session_id: str):
    session = sessions.get(session_id)
    if not session or session.config != active_config.get():
        error("Сессия не найдена", 404)
    return session.summary()


@app.post("/api/sessions")
async def create_session(request: Request):
    body = await request.json()
    target, route = body.get("target", ""), body.get("route", "")
    model = public_model(config_text())
    if target not in model["nodes"] or route and not any(r["name"] == route and r["target"] == target and not r.get("disabled") for r in model["routes"]):
        error("Неизвестный хост или маршрут")
    binding = bound_vault(request)
    access = vault_access(request, model, (target, route), binding=binding)
    hops = terminal_route_hosts(model, target, route)
    warnings = [{"node": node, "kind": "unpinned", "fingerprint": None} for node in sorted(hops) if not model["nodes"][node].get("host_key")]
    session = TerminalSession(target, route, warnings, binding[0])
    try:
        await session.start(access)
    except Exception as exc:
        error(f"Не удалось запустить CLI: {exc}", 500)
    sessions[session.id] = session
    return session.summary()


@app.put("/api/sessions/{session_id}/host-key")
async def save_host_key(session_id: str, request: Request):
    session = sessions.get(session_id)
    if not session or session.config != active_config.get():
        error("Сессия не найдена", 404)
    body = await request.json()
    if not isinstance(body, dict):
        error("Укажите отпечаток")
    async with config_lock:
        warning = next((item for item in session.host_key_warnings()
                        if item.get("id") is not None and item["id"] == body.get("id")), None)
        if not warning or warning["fingerprint"] != body.get("fingerprint"):
            error("Отпечаток больше не актуален. Проверьте текущий ключ", 409)
        original = config_text()
        model = public_model(original)
        name = warning["node"]
        node = model["nodes"].get(name)
        route = next((item for item in model["routes"]
                      if item["name"] == warning["route"] and item["target"] == session.target
                      and name in item["hops"] and not item.get("disabled")
                      and warning["route_path"] == f"{item['name']}: local -> " + " -> ".join(item["hops"])), None)
        address = (route.get("addresses") or {}).get(name, node["host"]) if node and route else None
        if (not node or address != warning["host"] or (node.get("port") or 22) != warning["port"]
                or node.get("host_key") != warning["expected"]):
            error("Адрес маршрута или закреплённый отпечаток изменился. Переподключитесь для проверки", 409)
        doc = tomlkit.parse(original)
        doc["nodes"][name]["host_key"] = warning["fingerprint"]
        candidate = tomlkit.dumps(doc)
        await validate_config(candidate)
        if config_text() != original:
            error("Конфигурация изменилась на диске. Повторите проверку отпечатка", 409)
        if not any(item.get("id") == warning["id"] for item in session.host_key_warnings()):
            error("Отпечаток изменился во время проверки", 409)
        write_config(candidate)
        affected = [item for item in sessions.values() if item.config == session.config
                    and name in terminal_route_hosts(model, item.target, item.route)]
        for item in affected:
            item.updated_keys[name] = warning["fingerprint"]
            item.warnings.pop(name, None)
            item.reload_config = True
    for item in affected:
        await item.broadcast({"type": "host_keys", "warnings": item.host_key_warnings()})
    return public_model(candidate)


@app.delete("/api/sessions/{session_id}")
async def terminate_session(session_id: str):
    session = sessions.get(session_id)
    if not session or session.config != active_config.get():
        error("Сессия не найдена", 404)
    async with session.reconnect_lock:
        await session.stop()
        return {"ok": True, "session": session.summary()}


@app.post("/api/sessions/{session_id}/reconnect")
async def reconnect_session(session_id: str, request: Request):
    session = sessions.get(session_id)
    if not session or session.config != active_config.get():
        error("Сессия не найдена", 404)
    async with session.reconnect_lock:
        running = session.process and session.process.returncode is None and session.master >= 0
        binding = bound_vault(request)
        if running and not session.reload_config and session.vault_id == binding[0]:
            os.write(session.master, b"\x1d")
            return session.summary()
        model = public_model(config_text())
        access = vault_access(request, model, (session.target, session.route), binding=binding)
        await session.stop()
        session.history.clear()
        session.host_keys.clear()
        session.updated_keys.clear()
        hops = terminal_route_hosts(model, session.target, session.route)
        session.warnings = {node: {"node": node, "kind": "unpinned", "fingerprint": None}
                            for node in hops if not model["nodes"][node].get("host_key")}
        session.reload_config = False
        await session.start(access)
        session.vault_id = binding[0]
    return session.summary()


@app.websocket("/ws/terminal/{session_id}")
async def terminal_ws(websocket: WebSocket, session_id: str):
    cookie = websocket.cookies.get(COOKIE, "")
    if not TOKEN or not hmac.compare_digest(cookie, session_value()) or not same_origin(websocket.headers):
        await websocket.close(code=1008)
        return
    session = sessions.get(session_id)
    selected = websocket.query_params.get("config")
    profiles = config_profiles()
    config = default_config(profiles) if selected is None else profiles.get(selected)
    if not session or session.config != config:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    try:
        async with session.output_lock:
            session.clients.add(websocket)
            if session.writer is None:
                session.writer = websocket
            await websocket.send_json({"type": "state", **session.summary(), "writer": session.writer is websocket})
            for chunk in list(session.history):
                await websocket.send_bytes(chunk)
            await websocket.send_json({"type": "history_end"})
        while True:
            message = await websocket.receive()
            if message.get("type") == "websocket.disconnect":
                break
            if "bytes" in message and session.writer is websocket and session.master >= 0:
                os.write(session.master, message["bytes"])
            elif "text" in message:
                command = json.loads(message["text"])
                if command.get("type") == "claim":
                    session.writer = websocket
                    for client in list(session.clients):
                        await client.send_json({"type": "writer", "writer": client is websocket})
                elif command.get("type") == "resize" and session.writer is websocket and session.master >= 0:
                    rows, cols = max(2, min(500, int(command.get("rows", 24)))), max(2, min(500, int(command.get("cols", 80))))
                    fcntl.ioctl(session.master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except (WebSocketDisconnect, OSError, ValueError, json.JSONDecodeError):
        pass
    finally:
        session.clients.discard(websocket)
        if session.writer is websocket:
            session.writer = next(iter(session.clients), None)
            if session.writer:
                await session.writer.send_json({"type": "writer", "writer": True})


def transfer_public(item):
    return {key: value for key, value in item.items() if key != "logs"} | {"logs": list(item["logs"])}


@app.get("/api/transfers")
async def list_transfers():
    return [transfer_public(item) for item in transfers.values()
            if item.get("config", DEFAULT_CONFIG.name) == active_config.get().name]


def transfer_endpoints(body):
    if "source" in body or "destination" in body:
        return body.get("source"), body.get("destination")
    direction = body.get("direction")
    if direction not in ("upload", "download"):
        error("Укажите направление передачи")
    local = {"host": "", "path": body.get("local")}
    remote = {"host": body.get("target"), "route": body.get("route", ""), "path": body.get("remote")}
    return (local, remote) if direction == "upload" else (remote, local)


def validated_endpoint(raw, model, *, source):
    if not isinstance(raw, dict):
        error("Укажите источник и назначение")
    host, route, path = raw.get("host", ""), raw.get("route", ""), raw.get("path")
    if not isinstance(host, str) or not isinstance(route, str) or not isinstance(path, str) or not path or "\0" in path:
        error("Укажите корректный путь, хост и маршрут")
    if host:
        if not path.startswith("/") or not selected_routes(model, host, route):
            error("Укажите абсолютный удалённый путь и доступный маршрут")
        if source and path.rstrip("/").split("/")[-1] in ("", ".", ".."):
            error("Выберите файл или каталог как источник")
        return {"host": host, "route": route, "path": path}, f"{host}:{path}"
    local = local_path(path, source)
    if source and (local == FILES.resolve() or not (local.is_file() or local.is_dir())):
        error("Выберите файл или каталог внутри /files")
    if not source and local.exists():
        error("Локальный файл или каталог уже существует", 409)
    return {"host": "", "route": "", "path": local.relative_to(FILES.resolve()).as_posix()}, str(local)


def copy_routes(model, source, destination):
    remotes = [end for end in (source, destination) if end["host"]]
    if len(remotes) == 2 and source["host"] == destination["host"]:
        if source["route"] and destination["route"] and source["route"] != destination["route"]:
            error("Для копирования на одном хосте выберите один маршрут")
        remotes = [{**source, "route": source["route"] or destination["route"]}]
    names = []
    if any(end["route"] for end in remotes):
        names = list(dict.fromkeys(route["name"] for end in remotes
                                  for route in selected_routes(model, end["host"], end["route"])))
    return remotes, names


async def remote_source_is_directory(source, route, access):
    args = ["--config", str(active_config.get())]
    if route:
        args += ["--route", route]
    code, out, stderr = await cli_run(*args, "--", "stat", source["host"], source["path"], timeout=45, access=access)
    if code:
        error(stderr.strip().splitlines()[-1] if stderr.strip() else "Не удалось проверить удалённый источник", 502)
    directory = out.strip()
    if directory not in ("true", "false"):
        error("mssh не вернул тип удалённого источника", 502)
    return directory == "true"


@app.post("/api/transfers")
async def create_transfer(request: Request):
    body = await request.json()
    if not isinstance(body, dict):
        error("Укажите источник и назначение")
    model = public_model(config_text())
    from_raw, to_raw = transfer_endpoints(body)
    source, from_arg = validated_endpoint(from_raw, model, source=True)
    destination, to_arg = validated_endpoint(to_raw, model, source=False)
    if not source["host"] and not destination["host"]:
        error("Выберите SSH-хост хотя бы в одной панели")
    if from_arg == to_arg:
        error("Источник и назначение совпадают")
    remote_copy = bool(source["host"] and destination["host"])
    remotes, routes = copy_routes(model, source, destination)
    access = vault_access(request, model, *((end["host"], end["route"]) for end in remotes))
    if "recursive" in body:
        recursive = bool(body["recursive"])
    elif source["host"]:
        recursive = await remote_source_is_directory(source, remotes[0]["route"], access)
    else:
        recursive = Path(from_arg).is_dir()
    verify = bool(body.get("verify"))
    item = {"id": uuid.uuid4().hex, "config": active_config.get().name, "source": source, "destination": destination, "recursive": recursive,
            "verify": verify, "state": "queued", "created": time.time(), "logs": deque(maxlen=100)}
    if not remote_copy:
        local, remote = (source, destination) if destination["host"] else (destination, source)
        item.update(target=remote["host"], route=remote["route"], remote=remote["path"], local=local["path"],
                    direction="upload" if destination["host"] else "download")
    args = ["--config", str(active_config.get())]
    for route in routes:
        args += ["--route", route]
    if recursive:
        args.append("-r")
    if verify:
        args.append("--verify")
    args += ["--max-routes", "1"] if remote_copy else ["--continue-partial"]
    args += ["--", from_arg, to_arg]
    transfers[item["id"]] = item
    try:
        save_history()
    except OSError:
        transfers.pop(item["id"], None)
        error("Не удалось сохранить историю передач", 500)
    asyncio.create_task(run_transfer(item, args, access))
    return transfer_public(item)


async def run_transfer(item, args, access: VaultAccess | Path | None):
    if item["state"] == "cancelled":
        return
    item["state"] = "running"
    try:
        process = await spawn_cli(CLI, args, vault=access, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, stdin=asyncio.subprocess.DEVNULL)
        transfer_processes[item["id"]] = process
        if item["state"] == "cancelled" and process.returncode is None:
            try:
                process.terminate()
            except ProcessLookupError:
                pass
        while line := await process.stdout.readline():
            item["logs"].append(line.decode(errors="replace").rstrip())
        await process.wait()
        if item["state"] != "cancelled":
            item["state"] = "done" if process.returncode == 0 else "error"
            if process.returncode:
                item["logs"].append(f"CLI завершился с кодом {process.returncode}")
    except Exception as exc:
        if item["state"] != "cancelled":
            item["state"] = "error"
            item["logs"].append(str(exc))
    finally:
        transfer_processes.pop(item["id"], None)
        save_history()


@app.post("/api/transfers/{transfer_id}/cancel")
async def cancel_transfer(transfer_id: str):
    item = transfers.get(transfer_id)
    if not item or item.get("config", DEFAULT_CONFIG.name) != active_config.get().name:
        error("Передача не найдена", 404)
    if item["state"] not in ("queued", "running"):
        return transfer_public(item)
    item["state"] = "cancelled"
    process = transfer_processes.get(transfer_id)
    if process and process.returncode is None:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
    save_history()
    return transfer_public(item)


@app.get("/api/about")
async def about():
    code, out, _ = await cli_run("--version")
    return {"ui": "0.1.0", "backend": "0.1.0", "cli": out.strip() if code == 0 else "unknown"}


DIST = Path(__file__).resolve().parent.parent / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")


@app.get("/{path:path}")
async def spa(path: str):
    if path.startswith(("api/", "ws/")):
        error("Not found", 404)
    return FileResponse(DIST / "index.html")
