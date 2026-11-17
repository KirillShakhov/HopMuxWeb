# HopMuxWeb

Локальная веб-оболочка для [HopMux / `mssh`](https://github.com/KirillShakhov/HopMux). Browser → React/TypeScript → FastAPI + WebSocket → `mssh` CLI → SSH. Dockerfile загружает **точно релиз 1.1.0** по указанной ссылке и сверяет SHA-256 архива перед установкой бинарника.

## Запуск

В каталоге проекта уже созданы локальные `.env` со случайным токеном и `config/config.toml` с примером хоста. Замените `edge.example.com`, пользователя и способ аутентификации в конфиге на свои значения. Файл `.env` и действующий TOML исключены из Git и Docker build context.

```powershell
cd C:\Users\kirill\Pets\HopMuxWeb
docker compose up -d --build
```

Откройте [http://127.0.0.1:8080](http://127.0.0.1:8080). Для входа используйте `HOPMUX_TOKEN` из локального `.env`.

Тома Compose:

- `./config` → `/config`: редактируемый TOML и резервная копия `config.toml.bak`;
- `SSH_DIR` из `.env` → `/home/hopmux/.ssh` только для чтения; `key_file = "~/.ssh/…"` ссылается сюда;
- `./files` → `/files`: разрешённые локальные файлы для передач и browser upload/download;
- `hopmux-data` → `/data`: история задач.

Порт опубликован только на `127.0.0.1`. Для удалённого доступа используйте HTTPS reverse proxy и отдельно настройте безопасную аутентификацию на его стороне. При запуске от UID 10001 каталоги `config` и `files` должны быть доступны ему на запись.

## Возможности

- Hosts: список, поиск, избранное, автоматический маршрут SSH по умолчанию с возможностью выбрать конкретный, отдельная проверка доступности.
- Config: граф направленных маршрутов, Visual-редактор хостов/путей, Monaco для TOML; валидация через `mssh config check`, атомарная запись и `.bak`.
- Terminal: PTY и WebSocket, resize, несколько вкладок/окон, одна активная точка ввода на `session_id`, detach/reconnect/terminate. CLI-процесс остаётся на сервере при закрытии браузера.
- Transfer: local ↔ remote через CLI, выбор маршрута, очередь задач, отмена/повтор, журнал, загрузка из браузера и скачивание в браузер.
- Workspace: до четырёх панелей, изменение размера, перенос вкладок, восстановление вкладок и раскладки в этом браузере.

CLI не выдаёт надёжный поток структурированного прогресса для foreground copy, поэтому UI показывает состояния и реальные сообщения CLI без вымышленных процентов, скорости и ETA. Сессии не переживают рестарт контейнера. Конфигурации с `include` можно редактировать в Raw TOML; Visual-редактор для них заблокирован, чтобы не потерять записи из включённых файлов. Встроенные пароли скрыты в API и редакторе: обычное сохранение сохраняет прежний пароль, а замена и удаление доступны только явным действием в Visual. Для новых хостов можно использовать `password_env`.

## Проверки

```powershell
npm ci
npm run build
docker compose build
docker compose ps
```

Backend smoke-тест (`tests/smoke.py`) проверяет вход, реальные `mssh config check`, сохранение Raw и Visual, резервную копию, отклонение несуществующих и циклических путей, сохранение и явное изменение секретов, защиту локальных путей. Он рассчитан на Python в Linux/WSL и распакованный релизный бинарник в `/tmp/mssh-linux-x86_64/mssh`.

## Интеграционный SSH-стенд

Стенд из соседнего репозитория HopMux создаёт пять альтернативных маршрутов к `target`, общие jump hosts, отдельные сети и ограничения скорости. Тестовый веб-контейнер использует тот же релизный образ, но отдельный конфиг и порт `127.0.0.1:8081`; основной экземпляр на `8080` не меняется. Тестовый контейнер запускается от root только для чтения закрытого ключа стенда из Docker volume.

```powershell
cd C:\Users\kirill\Pets\HopMux
docker compose -f compose.test.yaml up -d --build --wait --wait-timeout 900

cd C:\Users\kirill\Pets\HopMuxWeb
New-Item -ItemType Directory -Path test-stand\config,test-stand\files -Force
docker cp hopmux-test-client-1:/data/config.toml test-stand\config\config.toml
docker compose -f compose.stand.yaml up -d
docker compose -f compose.stand.yaml exec -T web python -u /tests/stand_e2e.py
```

Тест проверяет пять маршрутов, upload по `target-1` и `target-5`, download по `target-2` с SHA-256, PTY по `target-4` и передачу права ввода между окнами. Дополнительные сценарии: `--auto-only`, `--terminal-only target-1`, `--terminal-only target-5`, `--terminal-only entry3-1`, `--reattach-only`. Для проверки отказа остановите `entry1`, выполните `--failover-only`, затем запустите `entry1` обратно.
