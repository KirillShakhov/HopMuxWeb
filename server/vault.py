import asyncio
import hashlib
import os
import pty
import secrets
import sys
import tempfile
import tomllib
import tty
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path

import tomlkit
from fastapi import HTTPException


COOKIE = "hopmux_vault"
LEASE_SECONDS = 30 * 60
MAX_VAULT_BYTES = 4 * 1024 * 1024


def master_password(value) -> bytes:
    if not isinstance(value, str) or not value or any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise HTTPException(400, "Введите мастер-пароль без управляющих символов")
    try:
        encoded = value.encode()
    except UnicodeError:
        raise HTTPException(400, "Мастер-пароль содержит недопустимые символы") from None
    if len(encoded) > 1024:
        raise HTTPException(400, "Мастер-пароль слишком длинный")
    return encoded


async def spawn_prompted(argv, replies, *, inherited=(), **kwargs):
    master, slave = pty.openpty()
    try:
        # This TTY is only visible to mssh's /dev/tty prompts, never the web terminal.
        tty.setraw(slave)
        os.set_blocking(master, False)
        process = await asyncio.create_subprocess_exec(
            sys.executable, str(Path(__file__).with_name("pty_exec.py")), str(slave), *argv,
            start_new_session=True, pass_fds=(*inherited, slave), **kwargs,
        )
    except BaseException:
        os.close(master)
        os.close(slave)
        raise

    pending = deque(replies)
    received = bytearray()
    loop = asyncio.get_running_loop()

    def answer_prompt():
        try:
            received.extend(os.read(master, 4096))
            if pending and pending[0][0] in received:
                _, password = pending.popleft()
                received.clear()
                line = password + b"\n"
                if os.write(master, line) != len(line):
                    raise OSError("incomplete vault prompt response")
            if len(received) > 8192:
                del received[:-4096]
        except BlockingIOError:
            return
        except OSError:
            loop.remove_reader(master)
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass

    async def cleanup():
        try:
            await process.wait()
        finally:
            loop.remove_reader(master)
            os.close(master)
            os.close(slave)

    loop.add_reader(master, answer_prompt)
    asyncio.create_task(cleanup())
    return process


@dataclass
class VaultAccess:
    password: bytes = field(repr=False)
    encrypted: bytes = field(repr=False)


async def spawn_cli(cli: str, args, *, vault: VaultAccess | None = None, start_new_session=False, **kwargs):
    if vault is None:
        return await asyncio.create_subprocess_exec(cli, *args, start_new_session=start_new_session, **kwargs)
    # Keep the encrypted version stable if another request edits or rotates the vault.
    with os.fdopen(os.memfd_create("mssh-vault", os.MFD_CLOEXEC), "w+b") as frozen:
        frozen.write(vault.encrypted)
        frozen.seek(0)
        path = f"/proc/self/fd/{frozen.fileno()}"
        return await spawn_prompted(
            [cli, "--vault-file", path, *args],
            [(f"Vault password ({path}): ".encode(), vault.password)],
            inherited=(frozen.fileno(),), **kwargs,
        )


@dataclass
class Lease:
    password: bytes = field(repr=False)
    revision: bytes
    entries: frozenset[str]


class Vault:
    def __init__(self, cli: str, config: Path, file: Path | None = None):
        self.cli = cli
        self.config = config
        self.file = file
        self.leases: dict[str, Lease] = {}
        self.lock = asyncio.Lock()

    def path(self):
        if self.file is not None:
            return self.file
        nearby = self.config.with_name("vault.json")
        if nearby.exists():
            return nearby
        xdg = os.getenv("XDG_CONFIG_HOME", "")
        config_home = Path(xdg) if os.path.isabs(xdg) else Path.home() / ".config"
        fallback = config_home / "mssh" / "vault.json"
        return fallback if fallback.exists() else nearby

    def read(self, path):
        try:
            with path.open("rb") as file:
                encrypted = file.read(MAX_VAULT_BYTES + 1)
        except FileNotFoundError:
            return None
        except OSError:
            raise HTTPException(500, "Не удалось прочитать хранилище mssh") from None
        if len(encrypted) > MAX_VAULT_BYTES:
            raise HTTPException(413, "Файл хранилища превышает 4 МиБ")
        return encrypted

    def lease(self, token, encrypted):
        lease = self.leases.get(token)
        if lease and (encrypted is None or lease.revision != hashlib.sha256(encrypted).digest()):
            self.leases.pop(token, None)
            return None
        return lease

    def remember(self, password, encrypted, entries):
        token = secrets.token_urlsafe(32)
        self.leases[token] = Lease(password, hashlib.sha256(encrypted).digest(), frozenset(entries))
        asyncio.get_running_loop().call_later(LEASE_SECONDS, self.leases.pop, token, None)
        return token

    def status(self, token):
        encrypted = self.read(self.path())
        lease = self.lease(token, encrypted)
        return {"exists": encrypted is not None, "unlocked": lease is not None,
                "entries": sorted(lease.entries) if lease else []}

    def access(self, token, route_entries):
        if not any(route_entries):
            return None
        encrypted = self.read(self.path())
        lease = self.lease(token, encrypted)
        if lease is None and any(not entries for entries in route_entries):
            return None
        if encrypted is None:
            raise HTTPException(409, "Создайте хранилище в разделе «Хранилище»")
        if lease is None:
            raise HTTPException(423, "Разблокируйте хранилище mssh")
        if not any(entries <= lease.entries for entries in route_entries):
            missing = sorted(set.union(*route_entries) - lease.entries)
            raise HTTPException(409, "В хранилище нет записей: " + ", ".join(missing))
        return VaultAccess(lease.password, encrypted)

    async def command(self, file, action, plaintext, replies):
        process = await spawn_prompted(
            [self.cli, "--config", str(self.config), "--vault-file", str(file), "vault", action, str(plaintext)],
            replies, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            _, stderr = await asyncio.wait_for(process.communicate(), 45)
        except (TimeoutError, asyncio.CancelledError) as exc:
            if process.returncode is None:
                process.kill()
                await process.wait()
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise HTTPException(504, "mssh не завершил операцию с хранилищем") from None
        if process.returncode:
            if b"wrong vault password or damaged vault" in stderr:
                raise HTTPException(400, "Неверный мастер-пароль или повреждённое хранилище")
            if action == "decrypt":
                raise HTTPException(400, "Не удалось открыть файл хранилища mssh")
            raise HTTPException(500, "mssh не смог зашифровать хранилище")

    async def decrypt(self, encrypted, password):
        # CLI encrypt/decrypt needs filenames. Plaintext is staged only on tmpfs.
        with tempfile.TemporaryDirectory(prefix="hopmux-vault-", dir="/dev/shm") as directory:
            envelope = Path(directory) / "vault.json"
            plaintext = Path(directory) / "passwords.toml"
            envelope.write_bytes(encrypted)
            await self.command(envelope, "decrypt", plaintext, [(b"Vault password: ", password)])
            with plaintext.open("rb") as file:
                return tomllib.load(file)["passwords"]

    async def encrypt(self, entries, password):
        with tempfile.TemporaryDirectory(prefix="hopmux-vault-", dir="/dev/shm") as directory:
            envelope = Path(directory) / "vault.json"
            plaintext = Path(directory) / "passwords.toml"
            try:
                encoded = tomlkit.dumps({"passwords": entries}).encode()
            except (ValueError, UnicodeError):
                raise HTTPException(400, "Имя записи или пароль содержит недопустимые символы") from None
            # The CLI's JSON envelope encodes the ciphertext in hexadecimal.
            if len(encoded) > (MAX_VAULT_BYTES - 512) // 2:
                raise HTTPException(413, "Записи превышают допустимый размер хранилища")
            plaintext.write_bytes(encoded)
            await self.command(envelope, "encrypt", plaintext, [
                (b"New vault password: ", password), (b"Confirm vault password: ", password),
            ])
            return self.read(envelope)

    def write(self, path, expected, encrypted):
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            fd, temporary = tempfile.mkstemp(prefix=".hopmux-vault-", dir=path.parent)
            try:
                with os.fdopen(fd, "wb") as file:
                    file.write(encrypted)
                    file.flush()
                    os.fsync(file.fileno())
                if self.read(path) != expected:
                    raise HTTPException(409, "Файл хранилища изменился. Разблокируйте его заново")
                if expected is None:
                    os.link(temporary, path)
                else:
                    os.replace(temporary, path)
            finally:
                Path(temporary).unlink(missing_ok=True)
        except FileExistsError:
            raise HTTPException(409, "Хранилище уже существует") from None
        except OSError:
            raise HTTPException(500, "Не удалось записать хранилище mssh") from None

    async def unlock(self, password, *, create=False):
        async with self.lock:
            path = self.path()
            encrypted = self.read(path)
            if create:
                if encrypted is not None:
                    raise HTTPException(409, "Хранилище уже существует")
                entries = {}
                encrypted = await self.encrypt(entries, password)
                self.write(path, None, encrypted)
            else:
                if encrypted is None:
                    raise HTTPException(404, "Хранилище ещё не создано")
                entries = await self.decrypt(encrypted, password)
            return self.remember(password, encrypted, entries)

    async def change(self, token, update, *, password=None):
        async with self.lock:
            path = self.path()
            original = self.read(path)
            lease = self.lease(token, original)
            if lease is None:
                raise HTTPException(423, "Разблокируйте хранилище mssh")
            entries = await self.decrypt(original, lease.password)
            update(entries)
            if self.leases.get(token) is not lease:
                raise HTTPException(423, "Разблокируйте хранилище mssh")
            encrypted = await self.encrypt(entries, password or lease.password)
            if self.leases.get(token) is not lease:
                raise HTTPException(423, "Разблокируйте хранилище mssh")
            self.write(path, original, encrypted)
            revision = hashlib.sha256(encrypted).digest()
            previous_revision = lease.revision
            for key, current in list(self.leases.items()):
                if current.revision != previous_revision:
                    continue
                if key != token and password is not None:
                    self.leases.pop(key, None)
                else:
                    current.revision = revision
                    current.entries = frozenset(entries)
                    if password is not None:
                        current.password = password
            return self.status(token)
