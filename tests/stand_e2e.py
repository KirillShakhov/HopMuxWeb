"""Run inside the stand web container after the HopMux SSH stand is healthy."""
import asyncio
import hashlib
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import uuid

from websockets.asyncio.client import connect

BASE = "http://127.0.0.1:8000"
COOKIE = http.cookiejar.CookieJar()
OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(COOKIE))
NAME = "hopmuxweb-e2e-" + uuid.uuid4().hex[:10] + ".bin"
PAYLOAD = ("HopMuxWeb route and transfer test\n" * 64).encode()


def request(method, path, body=None, content_type="application/json"):
    data = None if body is None else (json.dumps(body).encode() if content_type == "application/json" else body)
    req = urllib.request.Request(BASE + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", content_type)
    try:
        with OPENER.open(req, timeout=130) as response:
            content = response.read()
            return json.loads(content) if response.headers.get("Content-Type", "").startswith("application/json") else content
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"{method} {path}: HTTP {exc.code} {exc.read().decode(errors='replace')}") from exc


def wait_transfer(transfer_id, timeout=180):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        item = next(t for t in request("GET", "/api/transfers") if t["id"] == transfer_id)
        if item["state"] in ("done", "error", "cancelled"):
            if item["state"] != "done":
                raise RuntimeError(f"Transfer {transfer_id}: {item['state']} {item['logs']}")
            return item
        time.sleep(1)
    raise TimeoutError(f"Transfer {transfer_id} timed out")


async def terminal_test(target="target", route="target-4"):
    session = request("POST", "/api/sessions", {"target": target, "route": route})
    cookie = next(c for c in COOKIE if c.name == "hopmux_session")
    url = f"ws://127.0.0.1:8000/ws/terminal/{session['id']}"
    try:
        async with connect(url, additional_headers={"Cookie": f"hopmux_session={cookie.value}"}) as first:
            first_state = json.loads(await asyncio.wait_for(first.recv(), 10))
            assert first_state["writer"] is True
            async with connect(url, additional_headers={"Cookie": f"hopmux_session={cookie.value}"}) as second:
                second_state = json.loads(await asyncio.wait_for(second.recv(), 10))
                assert second_state["writer"] is False
                await second.send(b"echo SECOND_SHOULD_NOT_WRITE\n")
                await second.send(json.dumps({"type": "claim"}))
                # After claiming input, the second window owns the PTY.
                deadline = time.monotonic() + 15
                claimed = False
                while time.monotonic() < deadline:
                    message = await asyncio.wait_for(second.recv(), 15)
                    if isinstance(message, str) and json.loads(message).get("type") == "writer":
                        claimed = json.loads(message)["writer"]
                        break
                assert claimed
                await second.send(b"echo HOPMUXWEB_TERMINAL_OK\n")
                output = b""
                deadline = time.monotonic() + 100
                while time.monotonic() < deadline:
                    message = await asyncio.wait_for(second.recv(), 100)
                    if isinstance(message, bytes):
                        output += message
                        if re.search(rb"(?:^|\r?\n)HOPMUXWEB_TERMINAL_OK\r?\n", output):
                            print(f"Terminal {route}: interactive PTY and writer handoff OK")
                            return
                raise TimeoutError("Terminal command output not observed")
    finally:
        request("DELETE", "/api/sessions/" + session["id"])


async def detach_reattach_test():
    session = request("POST", "/api/sessions", {"target": "target", "route": "target-2"})
    cookie = next(c for c in COOKIE if c.name == "hopmux_session")
    url = f"ws://127.0.0.1:8000/ws/terminal/{session['id']}"
    headers = {"Cookie": f"hopmux_session={cookie.value}"}
    try:
        async with connect(url, additional_headers=headers) as first:
            state = json.loads(await asyncio.wait_for(first.recv(), 10))
            assert state["writer"] is True
        listed = request("GET", "/api/sessions")
        assert any(s["id"] == session["id"] and s["state"] == "connected" for s in listed)
        async with connect(url, additional_headers=headers) as second:
            state = json.loads(await asyncio.wait_for(second.recv(), 10))
            assert state["writer"] is True
            await second.send(b"echo HOPMUXWEB_REATTACH_OK\n")
            output = b""
            deadline = time.monotonic() + 100
            while time.monotonic() < deadline:
                message = await asyncio.wait_for(second.recv(), 100)
                if isinstance(message, bytes):
                    output += message
                    if re.search(rb"(?:^|\r?\n)HOPMUXWEB_REATTACH_OK\r?\n", output):
                        print("Detach and reattach: backend PTY kept running")
                        return
            raise TimeoutError("Reattached terminal did not return command output")
    finally:
        request("DELETE", "/api/sessions/" + session["id"])


def main():
    request("POST", "/api/login", {"token": os.environ["HOPMUX_TOKEN"]})
    config = request("GET", "/api/config")
    assert len(config["nodes"]) == 14, len(config["nodes"])
    routes = [r for r in config["routes"] if r["target"] == "target"]
    assert len(routes) == 5, routes
    print("Config: 14 hosts, five target routes")

    probe = request("POST", "/api/probe/target")
    states = {r["route"]: r["state"] for r in probe["routes"]}
    assert states == {f"target-{i}": "UP" for i in range(1, 6)}, states
    print("Probe: all five target routes UP")

    boundary = "hopmuxweb-test-boundary"
    upload_body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{NAME}\"\r\nContent-Type: application/octet-stream\r\n\r\n".encode() + PAYLOAD + f"\r\n--{boundary}--\r\n".encode())
    browser_file = request("POST", "/api/files/upload", upload_body, f"multipart/form-data; boundary={boundary}")
    assert browser_file["path"] == NAME
    remote1 = f"/home/mssh/data/route1-{NAME}"
    remote5 = f"/home/mssh/data/route5-{NAME}"
    first = request("POST", "/api/transfers", {"target": "target", "route": "target-1", "direction": "upload", "local": NAME, "remote": remote1})
    wait_transfer(first["id"])
    print("Upload target-1: done")
    fifth = request("POST", "/api/transfers", {"target": "target", "route": "target-5", "direction": "upload", "local": NAME, "remote": remote5})
    wait_transfer(fifth["id"])
    print("Upload target-5: done")
    local_download = "download-" + NAME
    second = request("POST", "/api/transfers", {"target": "target", "route": "target-2", "direction": "download", "local": local_download, "remote": remote1})
    wait_transfer(second["id"])
    downloaded = request("GET", "/api/files/download?path=" + local_download)
    assert downloaded == PAYLOAD
    print("Download target-2 and browser download: SHA-256", hashlib.sha256(downloaded).hexdigest())

    asyncio.run(terminal_test())
    print("REMOTE_PATHS", remote1, remote5)
    print("ALL_STAND_E2E_CHECKS_PASSED")


def failover_test():
    request("POST", "/api/login", {"token": os.environ["HOPMUX_TOKEN"]})
    probe = request("POST", "/api/probe/target")
    states = {r["route"]: r["state"] for r in probe["routes"]}
    assert states["target-1"] != "UP", states
    assert all(states[f"target-{i}"] == "UP" for i in range(2, 6)), states
    print("Failover probe:", states)
    local_file = next(e["name"] for e in request("GET", "/api/files")["entries"] if e["name"].startswith("hopmuxweb-e2e-") and not e["name"].startswith("download-"))
    remote = f"/home/mssh/data/failover-{uuid.uuid4().hex[:10]}.bin"
    task = request("POST", "/api/transfers", {"target": "target", "route": "", "direction": "upload", "local": local_file, "remote": remote})
    wait_transfer(task["id"], 240)
    print("Auto-route upload after entry1 failure: done", remote)


if __name__ == "__main__":
    if "--terminal-only" in sys.argv:
        request("POST", "/api/login", {"token": os.environ["HOPMUX_TOKEN"]})
        position = sys.argv.index("--terminal-only")
        route = sys.argv[position + 1] if len(sys.argv) > position + 1 else "target-4"
        asyncio.run(terminal_test(route.split("-")[0], route))
    elif "--failover-only" in sys.argv:
        failover_test()
    elif "--reattach-only" in sys.argv:
        request("POST", "/api/login", {"token": os.environ["HOPMUX_TOKEN"]})
        asyncio.run(detach_reattach_test())
    else:
        main()
