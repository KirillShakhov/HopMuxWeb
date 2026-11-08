"""Local adapter smoke test using the actual mssh release binary."""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
root = Path(tempfile.mkdtemp(prefix="hopmuxweb-smoke-"))
(root / "config").mkdir()
(root / "files").mkdir()
config = root / "config" / "config.toml"
config.write_text('direct_hosts = ["edge"]\npaths = []\n[nodes.edge]\nhost = "example.com"\nuser = "alice"\nagent = true\n', encoding="utf-8")
os.environ["HOPMUX_CONFIG"] = str(config)
os.environ["HOPMUX_DATA"] = str(root / "data")
os.environ["HOPMUX_FILES"] = str(root / "files")
os.environ["HOPMUX_TOKEN"] = "smoke-token"
os.environ["HOPMUX_CLI"] = "/tmp/mssh-linux-x86_64/mssh"

from fastapi.testclient import TestClient  # noqa: E402
from server.app import app, route_model  # noqa: E402
import tomlkit  # noqa: E402

sample = tomlkit.parse('direct_hosts = ["a", "b"]\npaths = [["a", "relay"], ["relay", "target"], ["b", "target"]]\n')
derived = route_model(sample)
assert [r['hops'] for r in derived if r['target'] == 'target'] == [['a', 'relay', 'target'], ['b', 'target']]

with TestClient(app) as client:
    assert client.get("/api/config").status_code == 401
    assert client.post("/api/login", json={"token": "wrong"}).status_code == 401
    assert client.post("/api/login", json={"token": "smoke-token"}).status_code == 200
    loaded = client.get("/api/config")
    assert loaded.status_code == 200, loaded.text
    model = loaded.json()
    assert model["routes"][0]["name"] == "edge-1"
    assert client.post("/api/config/check", json={"text": model["text"]}).status_code == 200
    assert client.put("/api/config", json={"text": "bad = [", "version": model["version"]}).status_code == 400
    assert config.read_text(encoding="utf-8").startswith("direct_hosts")
    updated = model["text"].replace("example.com", "edge.example.org")
    result = client.put("/api/config", json={"text": updated, "version": model["version"]})
    assert result.status_code == 200, result.text
    assert "edge.example.org" in config.read_text(encoding="utf-8")
    assert config.with_suffix(".toml.bak").exists()
    visual = result.json()
    visual["nodes"]["edge"]["user"] = "bob"
    changed = client.put("/api/config/visual", json={"model": visual, "version": visual["version"], "legacy": visual["legacy"]})
    assert changed.status_code == 200, changed.text
    assert 'user = "bob"' in config.read_text(encoding="utf-8")
    assert client.get("/api/files", params={"path": "../"}).status_code == 400
    assert client.post("/api/transfers", json={"target":"edge", "direction":"upload", "local":"../bad", "remote":"/tmp/bad"}).status_code == 400
    config.write_text('bad = [', encoding='utf-8')
    broken = client.get('/api/config')
    assert broken.status_code == 200
    assert broken.json()['parse_error']
    assert broken.json()['text'] == 'bad = ['
    fixed = client.put('/api/config', json={'text': 'direct_hosts = ["edge"]\n[nodes.edge]\nhost = "fixed.example.org"\nuser = "alice"\nagent = true\n', 'version': broken.json()['version']})
    assert fixed.status_code == 200, fixed.text
print("Smoke checks passed")
