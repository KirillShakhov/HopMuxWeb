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
os.environ["HOPMUX_VAULT_FILE"] = str(config.with_name("vault.json"))
os.environ["HOPMUX_DATA"] = str(root / "data")
os.environ["HOPMUX_FILES"] = str(root / "files")
os.environ["HOPMUX_TOKEN"] = "smoke-token"

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

    assert client.get("/api/vault").json() == {"exists": False, "unlocked": False, "entries": []}
    master = "Тестовый мастер-пароль"
    unlock = {"password": master, "confirmation": master}
    created_vault = client.post("/api/vault/create", json=unlock)
    assert created_vault.status_code == 200, created_vault.text
    assert created_vault.json()["unlocked"]
    entry = {"name": "edge-auth", "password": "synthetic-vault-entry"}
    saved_entry = client.put("/api/vault/entries", json=entry)
    assert saved_entry.status_code == 200, saved_entry.text
    assert saved_entry.json()["entries"] == ["edge-auth"]
    assert entry["password"] not in saved_entry.text
    backup = client.get("/api/vault/backup")
    assert backup.status_code == 200 and backup.json()["version"] == 1
    assert master not in backup.text and entry["password"] not in backup.text
    config.write_text(config.read_text(encoding="utf-8") + '\npassword_vault = "edge-auth"\n', encoding="utf-8")
    assert client.request("DELETE", "/api/vault/entries", json={"name": "edge-auth"}).status_code == 409
    with TestClient(app) as other:
        assert other.post("/api/login", json={"token": "smoke-token"}).status_code == 200
        assert other.get("/api/vault").json() == {"exists": True, "unlocked": False, "entries": []}
        assert other.post("/api/probe/edge").status_code == 423
        assert other.post("/api/vault/unlock", json={"password": master}).status_code == 200
        rotation = client.post("/api/vault/rotate", json={"password": "rotated", "confirmation": "rotated"})
        assert rotation.status_code == 200, rotation.text
        assert not other.get("/api/vault").json()["unlocked"]
    assert client.post("/api/vault/lock").status_code == 200
    assert client.post("/api/vault/unlock", json={"password": master}).status_code == 400
    assert client.post("/api/vault/unlock", json={"password": "rotated"}).json()["entries"] == ["edge-auth"]

    config.write_text(
        'direct_hosts = ["edge"]\n[nodes.edge]\nhost = "edge.test.invalid"\nuser = "alice"\npassword = "last-line-secret"',
        encoding="utf-8",
    )
    draft = client.get("/api/config").json()
    draft["nodes"]["new_host"] = {"host": "new.test.invalid", "user": "alice", "password_vault": "edge-auth"}
    composed = client.post("/api/config/compose", json={"text": draft["text"], "model": draft, "legacy": draft["legacy"]})
    assert composed.status_code == 200, composed.text
    assert "last-line-secret" not in composed.text
    saved = client.put("/api/config", json={"text": composed.json()["text"], "version": draft["version"]})
    assert saved.status_code == 200, saved.text
    actual = tomlkit.parse(config.read_text(encoding="utf-8"))["nodes"]
    assert actual["edge"]["password"] == "last-line-secret"
    assert actual["new_host"]["password_vault"] == "edge-auth"
    assert "last-line-secret" not in saved.text

    lab = config.with_name("lab.toml")
    fragment = config.with_name("hosts.toml")
    fragment.write_text('[nodes.extra]\nhost = "extra.test.invalid"\nuser = "alice"\nagent = true\n', encoding="utf-8")
    lab.write_text('include = ["hosts.toml"]\ndirect_hosts = ["edge"]\n[nodes.edge]\nhost = "lab.test.invalid"\nuser = "alice"\nagent = true\n', encoding="utf-8")
    assert client.get("/api/configurations").json() == {
        "files": ["config.toml", "lab.toml"], "default": "config.toml", "legacy": "config.toml",
    }
    assert client.get("/api/config", params={"config": "../lab.toml"}).status_code == 404
    assert client.get("/api/config", params={"config": "hosts.toml"}).status_code == 404
    original = config.read_text(encoding="utf-8")
    params = {"config": "lab.toml"}
    loaded_lab = client.get("/api/config", params=params).json()
    candidate = loaded_lab["text"].replace("lab.test.invalid", "lab-updated.test.invalid")
    saved_lab = client.put("/api/config", params=params, json={"text": candidate, "version": loaded_lab["version"]})
    assert saved_lab.status_code == 200, saved_lab.text
    assert "lab-updated.test.invalid" in lab.read_text(encoding="utf-8")
    assert config.read_text(encoding="utf-8") == original
    assert client.get("/api/vault", params=params).json()["unlocked"]
    assert client.request("DELETE", "/api/vault/entries", params=params, json={"name": "edge-auth"}).status_code == 409

    assert client.post("/api/configurations", json={"name": "../outside"}).status_code == 400
    assert client.post("/api/configurations", json={"name": "lab.toml"}).status_code == 409
    created = client.post("/api/configurations", json={"name": "Новая конфигурация"})
    assert created.status_code == 201, created.text
    name = created.json()["name"]
    assert name == "Новая конфигурация.toml"
    assert name in created.json()["catalog"]["files"]
    params = {"config": name}
    blank = client.get("/api/config", params=params).json()
    assert blank["nodes"] == {}
    first_host = '[nodes.first]\nhost = "first.test.invalid"\nuser = "alice"\nagent = true\n'
    assert client.put("/api/config", params=params, json={"text": first_host, "version": blank["version"]}).status_code == 200
    assert client.get("/api/config", params=params).json()["nodes"]["first"]["host"] == "first.test.invalid"
    assert config.read_text(encoding="utf-8") == original
print("Smoke checks passed")
