# windbu

**Локальный gateway для [Windsurf AI](https://windsurf.com).**
Один OpenAI/Anthropic-совместимый endpoint поверх нескольких Windsurf-аккаунтов. Подключи Claude Code, Cursor, Cline, OpenCode, Continue, RooCode, Droid, Kilo Code — любой клиент с custom endpoint.

> Одна команда для установки. Ноль настроек для первого запуска. Работает на Windows (primary), macOS, Linux, Docker.

---

## 🚀 Быстрый старт

### Windows (одна команда)

```powershell
git clone https://github.com/defomok-max/windroute.git windbu
cd windbu
node bin/windbu.mjs
```

Всё. Откроется дашборд на http://127.0.0.1:20129/dashboard, API ключ и пароль будут в терминале и в `%USERPROFILE%\.windbu\credentials.txt`.

Что происходит на первом запуске:

1. Автодетект Windsurf Language Server в 5 стандартных местах
2. Генерация случайного `API_KEY` (`sk-windbu-...`) и пароля дашборда
3. Запись `.env`, создание `%USERPROFILE%\.windbu\`
4. Запуск gateway + открытие дашборда в браузере
5. Добавление первого токена в пул через UI

### Docker

```bash
docker run -d \
  --name windbu \
  -p 20129:20129 \
  -v "$HOME/.windbu:/data" \
  ghcr.io/defomok-max/windroute:latest
```

Дашборд: http://localhost:20129/dashboard

Для работы чата нужен Windsurf LS — смонтируй бинарь и укажи `-e LS_BINARY_PATH=/path/to/language_server_linux_x64`.

### Установщик на Windows с полным UX

Если хочешь ярлык на рабочем столе, автостарт и прочее:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

---

## 🎯 Что умеет

| Функция | Описание |
|---------|----------|
| **OpenAI chat/completions + Responses** | Cursor, Cline, OpenCode, Aider — любой custom-endpoint клиент |
| **Anthropic /v1/messages** | Claude Code подключается через `ANTHROPIC_BASE_URL` |
| **Multi-account pool** | Круговая балансировка, tier-weighted RPM, автодисейбл при ошибках |
| **Единый API-key** | Один ключ для всех клиентов, генерится автоматически |
| **Streaming (SSE)** | Первый байт летит сразу, heartbeat для keepalive |
| **Web dashboard** | Аккаунты, прокси, аналитика, логи — всё через UI |
| **OAuth login** | Google / GitHub через Firebase, без ручного копирования токена |
| **Per-account прокси** | HTTP/SOCKS5, каждый аккаунт — свой IP |
| **Usage analytics** | Токены, credits, распределение по моделям и аккаунтам |
| **Persistent storage** | `%USERPROFILE%\.windbu\` (переживает рестарт) |
| **Автостарт** | Опционально, через ярлык в Startup |
| **100+ моделей** | Claude Opus/Sonnet/Haiku, GPT-5.x, Gemini 3, DeepSeek, Grok, Qwen, Kimi, GLM |

---

## 🔌 Подключение клиентов

### Claude Code

```bash
# Windows PowerShell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:20129'
$env:ANTHROPIC_API_KEY = '<API_KEY из credentials.txt>'
claude

# macOS / Linux
export ANTHROPIC_BASE_URL='http://127.0.0.1:20129'
export ANTHROPIC_API_KEY='<API_KEY>'
claude
```

### Cursor

Settings → Models → Custom OpenAI:
- **Base URL:** `http://127.0.0.1:20129/v1`
- **API Key:** `<API_KEY>`
- **Model:** `claude-sonnet-4.6`, `gpt-5.2-high`, `gemini-3.0-pro`, и т.д.

> Cursor фильтрует имена моделей со словом `claude`. Используй алиасы: `sonnet-4.6`, `opus-4.6`, `opus-4.7-max` — они работают без фильтра.

### Cline / Continue / RooCode / OpenCode / Aider

```
Provider: OpenAI Compatible
Base URL: http://127.0.0.1:20129/v1
API Key:  <API_KEY>
Model:    claude-sonnet-4.6
```

### Быстрая проверка

```bash
# Список моделей
curl http://127.0.0.1:20129/v1/models \
  -H "Authorization: Bearer <API_KEY>"

# Чат
curl http://127.0.0.1:20129/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_KEY>" \
  -d '{"model":"claude-sonnet-4.6","messages":[{"role":"user","content":"hi"}]}'
```

---

## 📋 CLI команды

```
windbu                   запустить gateway (auto-configure при первом запуске)
windbu start             то же самое
windbu install           интерактивный installer с ярлыком и автостартом (Windows)
windbu stop              остановить любой запущенный процесс
windbu login <token>     добавить Windsurf-токен в пул
windbu dashboard         открыть дашборд в браузере
windbu doctor            preflight-проверки (node, порт, data dir, LS binary)
windbu version           версия
windbu help              справка
```

### PowerShell-скрипты (Windows-специфичные)

| Скрипт | Что делает |
|---|---|
| `.\scripts\install.ps1` | Полный installer — ярлык, автостарт, OAuth, тест чата |
| `.\scripts\install.ps1 -Force` | Перегенерирует `.env` с новыми ключами |
| `.\scripts\start.ps1` | Запуск с watchdog'ом (auto-restart на crash) |
| `.\scripts\stop.ps1` | Остановка + kill LS children |
| `.\scripts\add-account.ps1 -Token '...'` | Добавить токен через CLI |
| `.\scripts\detect-ls.ps1` | Вывести путь к Windsurf LS |
| `.\scripts\download-ls.ps1` | Скачать LS-бинарь (~170 MB) |
| `.\scripts\enable-autostart.ps1` | Автозапуск при логине |
| `.\scripts\disable-autostart.ps1` | Выключить автозапуск |
| `.\scripts\uninstall.ps1` | Снести всё: автостарт, ярлык, данные |
| `node scripts/smoke.mjs` | 21 smoke-тест (varint, cache, SSRF, pool, auth) |

---

## 🌐 API endpoints

| Путь | Формат | Кто использует |
|------|--------|----------------|
| `POST /v1/chat/completions` | OpenAI chat | Cursor, Cline, Aider, OpenCode, Continue |
| `POST /v1/messages` | Anthropic messages | Claude Code, Claude SDK |
| `POST /v1/responses` | OpenAI Responses | OpenAI SDK v2 |
| `GET /v1/models` | OpenAI models list | все |
| `GET /health` | — | мониторинг |
| `POST /auth/login` | `{token}` | добавление аккаунта |
| `GET /auth/accounts` | — | список аккаунтов |
| `DELETE /auth/accounts/:id` | — | удаление аккаунта |
| `GET /dashboard` | HTML | веб-панель |

Все `/v1/*` требуют `Authorization: Bearer <API_KEY>` или `x-api-key: <API_KEY>`.

---

## ⚙️ Конфигурация

`.env` генерится автоматически при первом запуске. Правь руками если нужно:

| Переменная | Default | Что делает |
|-----------|---------|------------|
| `PORT` | `20129` | порт HTTP-сервера |
| `HOST` | `127.0.0.1` | биндинг (локал по умолчанию, не светится в LAN) |
| `API_KEY` | `sk-windbu-*` | ключ для клиентов |
| `DASHBOARD_PASSWORD` | auto | пароль дашборда |
| `LS_BINARY_PATH` | auto-detect | путь к `language_server_*.exe` |
| `LS_PORT` | `42100` | gRPC-порт LS (внутренний) |
| `DEFAULT_MODEL` | `claude-sonnet-4.6` | если клиент не передал `model` |
| `MAX_TOKENS` | `8192` | максимум токенов в ответе по умолчанию |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `WINDBU_DATA_DIR` | `%USERPROFILE%\.windbu` | корень данных |
| `CODEIUM_API_URL` | `https://server.self-serve.windsurf.com` | не меняй |

---

## 📂 Структура данных

```
%USERPROFILE%\.windbu\        (Windows)
~/.windbu/                    (macOS / Linux)
├── accounts.json             — пул Windsurf-токенов
├── proxy.json                — proxy-настройки
├── stats.json                — usage analytics (v2 schema)
├── runtime-config.json       — experimental flags, identity prompts
├── model-access.json         — allow/block списки моделей
├── credentials.txt           — один раз при установке: API_KEY + пароль
├── windbu.pid                — PID текущего процесса
├── workspace/                — рабочая область LS (чистится при старте)
├── ls-data/                  — data-dir LS (по инстансу на прокси)
├── ls/                       — скачанный LS-бинарь (если через download-ls.ps1)
└── logs/
    ├── app-YYYY-MM-DD.jsonl
    └── error-YYYY-MM-DD.jsonl
```

---

## 🧩 Как получить Windsurf-токен

1. Открой https://windsurf.com/editor/show-auth-token
2. Залогинься (если ещё нет), скопируй токен (`ott$...` или JWT)
3. Добавь в пул:
   - **Дашборд:** Accounts → Add → вставь токен → OK
   - **CLI:** `node bin/windbu.mjs login '<token>'`
   - **PowerShell:** `.\scripts\add-account.ps1 -Token '<token>'`

Добавлять можно сколько угодно — запросы будут распределяться round-robin с учётом tier (free / pro) и RPM-лимитов.

---

## 🐛 Troubleshooting

**`Language server binary not found`**
Установи [Windsurf](https://windsurf.com) или запусти `.\scripts\download-ls.ps1`. Альтернатива — укажи полный путь в `.env` → `LS_BINARY_PATH`.

**`Port 20129 already in use`**
```powershell
Get-NetTCPConnection -LocalPort 20129 | Select-Object OwningProcess
# Stop-Process -Id <pid> -Force
# или поменяй PORT в .env
```

**`No accounts available`**
Добавь хотя бы один токен — см. раздел выше.

**Cursor не видит claude-модели**
Используй алиасы без слова "claude": `sonnet-4.6`, `opus-4.6`, `haiku-4.5`, `opus-4.7-max`. Это фильтр Cursor, не windbu.

**Токен добавился, но `model_not_entitled`**
Free-аккаунт Windsurf даёт ограниченный список (в основном `gemini-2.5-flash`, `glm-4.7`). Для Claude/GPT нужен Pro-тариф.

**Процесс зомби после kill**
`.\scripts\stop.ps1` делает `taskkill /T /F` — сносит LS children вместе с основным процессом. Или используй `windbu stop`.

**Непонятно что происходит**
`windbu doctor` — проверит node, порт, data dir, LS binary. `windbu --help` — справка.

---

## 🧬 Архитектура

```
┌─────────────────┐
│   Your CLI      │  (Claude Code, Cursor, Cline, OpenCode...)
│   Tool          │
└────────┬────────┘
         │ http://127.0.0.1:20129/v1
         ▼
┌─────────────────────────────────────────────┐
│          windbu (local gateway)             │
│  • format translation (OpenAI ↔ Anthropic)  │
│  • multi-account pool (round-robin + RPM)   │
│  • per-account proxy (HTTP/SOCKS5)          │
│  • cascade conversation reuse (experimental)│
│  • SSRF-safe image fetch                    │
│  • cascade + rate-limit state persistence   │
└────────┬────────────────────────────────────┘
         │ gRPC over HTTP/2
         ▼
┌─────────────────────────────────────────────┐
│       Windsurf Language Server (local)      │
│  • StartCascade → SendUserCascadeMessage    │
│  • GetCascadeTrajectorySteps (polling)      │
│  • GetCascadeTrajectoryGeneratorMetadata    │
└────────┬────────────────────────────────────┘
         │
         ▼ server.self-serve.windsurf.com
```

---

## 🙏 Credits

Навеяно [decolua/9router](https://github.com/decolua/9router) — та же идея локального gateway'а с единым API-ключом.

Основано на [guanxiaol/WindsurfPoolAPI](https://github.com/guanxiaol/WindsurfPoolAPI) и [dwgx/WindsurfAPI](https://github.com/dwgx/WindsurfAPI) — исходная реверс-инженерия gRPC-протокола Cascade.

Полный список в [CREDITS.md](CREDITS.md).

---

## 📜 Лицензия

MIT. См. [LICENSE](LICENSE).
