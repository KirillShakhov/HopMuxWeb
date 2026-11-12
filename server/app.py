import asyncio
import hashlib
import hmac
import json
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
from pathlib import Path
from typing import Any

import tomlkit
from fastapi import FastAPI, File, Header, HTTPException, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

CONFIG = Path(os.getenv("HOPMUX_CONFIG", "/config/config.toml"))
DATA = Path(os.getenv("HOPMUX_DATA", "/data"))
FILES = Path(os.getenv("HOPMUX_FILES", "/files"))
TOKEN = os.getenv("HOPMUX_TOKEN", "")
CLI = os.getenv("HOPMUX_CLI", "mssh")
COOKIE = "hopmux_session"
REDACTED = "__HOPMUX_REDACTED__"  # accepted only for migration from older browser drafts
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
sessions: dict[str, "TerminalSession"] = {}
transfers: dict[str, dict[str, Any]] = {}
transfer_processes: dict[str, asyncio.subprocess.Process] = {}
config_lock = asyncio.Lock()
HISTORY = DATA / "transfers.json"


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
async def logout():
    response = JSONResponse({"ok": True})
    response.delete_cookie(COOKIE, path="/")
    return response


def config_text() -> str:
    try:
        return CONFIG.read_text(encoding="utf-8")
    except OSError as exc:
        error(f"Не удалось прочитать конфиг: {exc}", 500)


def redact_document(raw: str) -> str:
    doc = tomlkit.parse(raw)
    for node in doc.get("nodes", {}).values():
        if "password" in node:
            node.pop("password")
    return tomlkit.dumps(doc)


def restore_secrets(candidate: str, original: str, operations: dict | None = None) -> str:
    operations = operations or {}
    try:
        new = tomlkit.parse(candidate)
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
            node["password"] = old_node["password"]
        elif action == "replace":
            value = operation.get("value")
            if not isinstance(value, str) or not value:
                error(f"Введите новый пароль узла {name}")
            node["password"] = value
    return tomlkit.dumps(new)


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
    version = hashlib.sha256(raw.encode()).hexdigest()
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


async def cli_run(*args: str, timeout: int = 30, input_text: str | None = None):
    process = await asyncio.create_subprocess_exec(CLI, *args, stdin=asyncio.subprocess.PIPE if input_text is not None else asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
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
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=".hopmux-check-", suffix=".toml", dir=CONFIG.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(candidate)
        code, out, err = await cli_run("--config", temp_name, "config", "check")
        if code:
            error((err or out).strip() or "Конфигурация отклонена CLI")
        return out.strip()
    finally:
        Path(temp_name).unlink(missing_ok=True)


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
        result["version"] = hashlib.sha256(original.encode()).hexdigest()
        return result
    result = public_model(candidate)
    result["version"] = hashlib.sha256(original.encode()).hexdigest()
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
    result["version"] = hashlib.sha256(original.encode()).hexdigest()
    return result


def write_config(candidate: str):
    backup = CONFIG.with_suffix(CONFIG.suffix + ".bak")
    tmp = CONFIG.with_suffix(CONFIG.suffix + ".new")
    shutil.copy2(CONFIG, backup)
    try:
        tmp.write_text(candidate, encoding="utf-8")
        os.chmod(tmp, CONFIG.stat().st_mode & 0o777)
        os.replace(tmp, CONFIG)
    finally:
        tmp.unlink(missing_ok=True)


@app.put("/api/config")
async def put_config(request: Request):
    body = await request.json()
    async with config_lock:
        original = config_text()
        if hashlib.sha256(original.encode()).hexdigest() != body.get("version"):
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
        if hashlib.sha256(original.encode()).hexdigest() != body.get("version"):
            error("Конфигурация изменилась на диске", 409)
        candidate = compose_visual(original, body.get("model", {}), bool(body.get("legacy")))
        candidate = restore_secrets(candidate, original, body.get("secret_operations"))
        await validate_config(candidate)
        write_config(candidate)
        return public_model(candidate)


@app.get("/api/health")
async def health():
    return {"ok": True, "cli": CLI, "config_exists": CONFIG.exists()}


@app.post("/api/probe/{target}")
async def probe(target: str):
    if target not in public_model(config_text())["nodes"]:
        error("Неизвестный хост", 404)
    code, out, err = await cli_run("--config", str(CONFIG), "--json", "status", target, timeout=90)
    if not out.strip():
        error(err.strip() or "Нет ответа от CLI", 502)
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        error(err.strip() or out.strip(), 502)


def local_path(relative: str, must_exist: bool = False) -> Path:
    if not relative or Path(relative).is_absolute():
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
    return {"path": path, "entries": [{"name": p.name, "directory": p.is_dir(), "size": p.stat().st_size if p.is_file() else None} for p in sorted(directory.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower())) if not p.is_symlink()]}


@app.post("/api/files/upload")
async def browser_upload(file: UploadFile = File(...)):
    safe_name = Path(file.filename or "").name
    if not safe_name or safe_name in (".", ".."):
        error("Неверное имя файла")
    target = local_path(safe_name)
    if target.exists():
        error("Файл уже существует", 409)
    with target.open("xb") as output:
        while data := await file.read(1024 * 1024):
            output.write(data)
    return {"path": safe_name}


@app.get("/api/files/download")
async def browser_download(path: str):
    target = local_path(path, True)
    if not target.is_file():
        error("Это не файл")
    return FileResponse(target, filename=target.name)


class TerminalSession:
    def __init__(self, target: str, route: str, warnings: list[dict[str, Any]]):
        self.id = uuid.uuid4().hex
        self.target = target
        self.route = route
        self.state = "connecting"
        self.error = ""
        self.warnings = warnings
        self.active_route = route
        self.created = time.time()
        self.master = -1
        self.process = None
        self.clients: set[WebSocket] = set()
        self.writer: WebSocket | None = None
        self.history = deque(maxlen=512)
        self.stderr_task = None

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
        self.history.append(data)
        for client in list(self.clients):
            try:
                await client.send_bytes(data)
            except Exception:
                self.clients.discard(client)

    async def start(self):
        master, slave = pty.openpty()
        self.master = master
        await self.set_state("connecting")
        args = [CLI, "--debug", "--config", str(CONFIG)]
        if self.route:
            args += ["--route", self.route]
        args.append(self.target)
        try:
            self.process = await asyncio.create_subprocess_exec(*args, stdin=slave, stdout=slave, stderr=asyncio.subprocess.PIPE, start_new_session=True)
        except Exception:
            os.close(master)
            os.close(slave)
            self.master = -1
            raise
        os.close(slave)
        self.stderr_task = asyncio.create_task(self.read_stderr())
        asyncio.create_task(self.read_loop())

    async def read_stderr(self):
        while line := await self.process.stderr.readline():
            message = line.decode(errors="replace").strip()
            if message.startswith("[debug "):
                if "SSH shell: trying route" in message:
                    await self.set_state("connecting")
                elif "SSH host key on " in message:
                    await self.set_state("verifying_host_key")
                    if "rejected" in message:
                        match = re.search(r" at ([^: ]+): rejected", message)
                        if match:
                            node = match.group(1)
                            await self.broadcast({"type": "host_key_rejected", "node": node})
                elif "SSH shell: attached via" in message:
                    self.active_route = message.split("SSH shell: attached via", 1)[1].strip()
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
            await self.set_state("exited" if self.process.returncode == 0 else "error", self.error or (f"CLI завершился с кодом {self.process.returncode}" if self.process.returncode else ""))
        finally:
            os.close(self.master)
            self.master = -1

    def summary(self):
        return {"id": self.id, "target": self.target, "route": self.route, "active_route": self.active_route, "state": self.state, "error": self.error, "warnings": self.warnings, "created": self.created}


@app.get("/api/sessions")
async def list_sessions():
    return [session.summary() for session in sessions.values()]


@app.post("/api/sessions")
async def create_session(request: Request):
    body = await request.json()
    target, route = body.get("target", ""), body.get("route", "")
    model = public_model(config_text())
    if target not in model["nodes"] or route and not any(r["name"] == route and r["target"] == target and not r.get("disabled") for r in model["routes"]):
        error("Неизвестный хост или маршрут")
    selected_routes = [r for r in model["routes"] if r["target"] == target and not r.get("disabled") and (not route or r["name"] == route)]
    hops = set(hop for selected_route in selected_routes for hop in selected_route["hops"])
    warnings = [{"node": node, "kind": "unpinned", "fingerprint": None} for node in sorted(hops) if not model["nodes"][node].get("host_key")]
    session = TerminalSession(target, route, warnings)
    sessions[session.id] = session
    try:
        await session.start()
    except Exception as exc:
        sessions.pop(session.id, None)
        error(f"Не удалось запустить CLI: {exc}", 500)
    return session.summary()


@app.delete("/api/sessions/{session_id}")
async def terminate_session(session_id: str):
    session = sessions.get(session_id)
    if not session:
        error("Сессия не найдена", 404)
    if session.process and session.process.returncode is None:
        os.killpg(session.process.pid, signal.SIGTERM)
    return {"ok": True}


@app.post("/api/sessions/{session_id}/reconnect")
async def reconnect_session(session_id: str):
    session = sessions.get(session_id)
    if not session:
        error("Сессия не найдена", 404)
    if session.process and session.process.returncode is None and session.master >= 0:
        os.write(session.master, b"\x1d")
    else:
        session.history.clear()
        await session.start()
    return session.summary()


@app.websocket("/ws/terminal/{session_id}")
async def terminal_ws(websocket: WebSocket, session_id: str):
    cookie = websocket.cookies.get(COOKIE, "")
    if not TOKEN or not hmac.compare_digest(cookie, session_value()) or not same_origin(websocket.headers):
        await websocket.close(code=1008)
        return
    session = sessions.get(session_id)
    if not session:
        await websocket.close(code=1008)
        return
    await websocket.accept()
    session.clients.add(websocket)
    if session.writer is None:
        session.writer = websocket
    await websocket.send_json({"type": "state", **session.summary(), "writer": session.writer is websocket})
    for chunk in session.history:
        await websocket.send_bytes(chunk)
    try:
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
    return [transfer_public(item) for item in transfers.values()]


@app.post("/api/transfers")
async def create_transfer(request: Request):
    body = await request.json()
    target, route = body.get("target", ""), body.get("route", "")
    direction = body.get("direction")
    remote = body.get("remote", "")
    model = public_model(config_text())
    if target not in model["nodes"] or route and not any(r["name"] == route and r["target"] == target for r in model["routes"]):
        error("Неизвестный хост или маршрут")
    if direction not in ("upload", "download") or not isinstance(remote, str) or not remote.startswith("/") or ":" in remote:
        error("Укажите направление и абсолютный удалённый путь")
    local = local_path(body.get("local", ""), direction == "upload")
    if direction == "download" and local.exists():
        error("Локальный файл уже существует", 409)
    if direction == "upload" and not local.is_file() and not local.is_dir():
        error("Локальный источник не найден")
    item = {"id": uuid.uuid4().hex, "target": target, "route": route, "direction": direction, "local": body["local"], "remote": remote, "state": "queued", "created": time.time(), "logs": deque(maxlen=100)}
    transfers[item["id"]] = item
    save_history()
    asyncio.create_task(run_transfer(item, bool(body.get("recursive")), bool(body.get("verify"))))
    return transfer_public(item)


async def run_transfer(item, recursive=False, verify=False):
    args = [CLI, "--config", str(CONFIG)]
    if item["route"]:
        args += ["--route", item["route"]]
    if recursive:
        args.append("-r")
    if verify:
        args.append("--verify")
    args.append("--continue-partial")
    local = str(local_path(item["local"], item["direction"] == "upload"))
    remote = f'{item["target"]}:{item["remote"]}'
    args += [local, remote] if item["direction"] == "upload" else [remote, local]
    item["state"] = "running"
    try:
        process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, stdin=asyncio.subprocess.DEVNULL)
        transfer_processes[item["id"]] = process
        while line := await process.stdout.readline():
            item["logs"].append(line.decode(errors="replace").rstrip())
        await process.wait()
        if item["state"] != "cancelled":
            item["state"] = "done" if process.returncode == 0 else "error"
            if process.returncode:
                item["logs"].append(f"CLI завершился с кодом {process.returncode}")
    except Exception as exc:
        item["state"] = "error"
        item["logs"].append(str(exc))
    finally:
        transfer_processes.pop(item["id"], None)
        save_history()


@app.post("/api/transfers/{transfer_id}/cancel")
async def cancel_transfer(transfer_id: str):
    item = transfers.get(transfer_id)
    if not item:
        error("Передача не найдена", 404)
    process = transfer_processes.get(transfer_id)
    if process and process.returncode is None:
        process.terminate()
    item["state"] = "cancelled"
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
