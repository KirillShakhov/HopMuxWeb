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
    missing_host = 'direct_hosts = ["edge"]\npaths = [["edge", "ghost"]]\n[nodes.edge]\nhost = "example.org"\nuser = "alice"\nagent = true\n'
    assert client.post('/api/config/check', json={'text': missing_host}).status_code == 400
    cyclic_path = 'direct_hosts = ["edge"]\npaths = [["edge", "edge"]]\n[nodes.edge]\nhost = "example.org"\nuser = "alice"\nagent = true\n'
    assert client.post('/api/config/check', json={'text': cyclic_path}).status_code == 400
    assert client.get("/api/files", params={"path": "../"}).status_code == 400
    assert client.post("/api/transfers", json={"target":"edge", "direction":"upload", "local":"../bad", "remote":"/tmp/bad"}).status_code == 400
    config.write_text('bad = [', encoding='utf-8')
    broken = client.get('/api/config')
    assert broken.status_code == 200
    assert broken.json()['parse_error']
    assert broken.json()['text'] == 'bad = ['
    config.write_text('nodes = { edge = { password = "hidden-inline" } }\nbad = [', encoding='utf-8')
    broken_secret = client.get('/api/config').json()
    assert 'hidden-inline' not in str(broken_secret)
    assert 'Исправьте файл на сервере' in broken_secret['text']
    config.write_text('bad = [', encoding='utf-8')
    fixed = client.put('/api/config', json={'text': 'direct_hosts = ["edge"]\n[nodes.edge]\nhost = "fixed.example.org"\nuser = "alice"\nagent = true\n', 'version': broken.json()['version']})
    assert fixed.status_code == 200, fixed.text
    config.write_text('direct_hosts = ["edge"]\n[nodes.edge]\nhost = "example.org"\nuser = "alice"\npassword = "private-value"\n', encoding='utf-8')
    secret_model = client.get('/api/config').json()
    assert secret_model['nodes']['edge']['has_inline_password'] is True
    assert 'private-value' not in str(secret_model)
    assert '__HOPMUX_REDACTED__' not in secret_model['text']
    preview = client.post('/api/config/preview', json={'text': secret_model['text'].replace('example.org', 'new.example.org')})
    assert preview.status_code == 200, preview.text
    assert preview.json()['nodes']['edge']['has_inline_password'] is True
    assert 'private-value' not in preview.text
    retained = client.put('/api/config', json={'text': preview.json()['text'], 'version': secret_model['version']})
    assert retained.status_code == 200, retained.text
    assert 'password = "private-value"' in config.read_text(encoding='utf-8')
    assert 'private-value' not in retained.text
    replaced = client.put('/api/config', json={'text': retained.json()['text'], 'version': retained.json()['version'], 'secret_operations': {'edge': {'action': 'replace', 'value': 'other-value'}}})
    assert replaced.status_code == 200, replaced.text
    assert 'password = "other-value"' in config.read_text(encoding='utf-8')
    removed = client.put('/api/config', json={'text': replaced.json()['text'] + '\nagent = true\n', 'version': replaced.json()['version'], 'secret_operations': {'edge': {'action': 'remove'}}})
    assert removed.status_code == 200, removed.text
    assert 'password' not in config.read_text(encoding='utf-8')
print("Smoke checks passed")
