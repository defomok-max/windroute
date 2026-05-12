# windbu

Local gateway для [Windsurf AI](https://windsurf.com) под Windows. Берёт один или несколько Windsurf-токенов и отдаёт их как единый OpenAI/Anthropic-совместимый API. Подключи к Claude Code, Cursor, Cline, OpenCode — любому клиенту с custom OpenAI endpoint.

Проект навеян [decolua/9router](https://github.com/decolua/9router). Основан на [guanxiaol/WindsurfPoolAPI](https://github.com/guanxiaol/WindsurfPoolAPI) и [dwgx/WindsurfAPI](https://github.com/dwgx/WindsurfAPI) (attribution в [CREDITS.md](CREDITS.md)).

---

## Что умеет

- **OpenAI /v1/chat/completions + /v1/responses** — любой клиент с custom OpenAI endpoint.
- **Anthropic /v1/messages** — Claude Code подключается через `ANTHROPIC_BASE_URL`.
- **Multi-account pool** — добавляй сколько угодно Windsurf-токенов, запросы распределяются round-robin.
- **Единый API key для всех клиентов** — генерируется при установке.
- **Streaming (SSE)** — стримится с первой же секунды.
- **Web dashboard** — http://127.0.0.1:20129/dashboard, управление аккаунтами, прокси, аналитика.
- **OAuth login (Google/GitHub)** — через дашборд, вместо ручного копирования токена.
- **Per-account HTTP/SOCKS5 proxy** — для распределения нагрузки по разным IP.
- **Usage analytics** — токены, credits, распределение по моделям и аккаунтам.
- **Persistent storage** — `%USERPROFILE%\.windbu\` (аккаунты, статистика, логи).
- **Автостарт при логине** (опционально).
- **100+ моделей** — Claude Opus/Sonnet/Haiku, GPT-5.x, Gemini 3, DeepSeek, Grok, Qwen, Kimi, GLM.

---

## Установка (~1 минута)

Нужно:
- Windows 10/11
- Node.js ≥ 20 ([скачать](https://nodejs.org/))
- Установленный [Windsurf](https://windsurf.com) (или отдельно `language_server_windows_x64.exe`)

```powershell
cd D:\portfolio\project\windbu
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Что происходит:
1. Проверяется Node.js.
2. Автоматически ищется Language Server Windsurf в 5 стандартных местах.
3. Генерируются случайные `API_KEY` и `DASHBOARD_PASSWORD`, пишется `.env`.
4. Создаётся ярлык `windbu` на рабочем столе.
5. Спрашивается про автозапуск при логине.
6. Сервер поднимается, открывается дашборд в браузере.
7. `API_KEY` копируется в буфер обмена, всё пишется в `%USERPROFILE%\.windbu\credentials.txt`.

---

## Первые шаги после установки

### 1. Добавить Windsurf-токен

Токен берётся здесь: https://windsurf.com/editor/show-auth-token

Способ А — дашборд:
- Открой http://127.0.0.1:20129/dashboard
- Войди паролем (показан в терминале и в `credentials.txt`)
- **Accounts → Add → вставь токен → OK**

Способ Б — CLI:

```powershell
.\scripts\add-account.ps1 -Token 'ott$XXXXXX...'
```

### 2. Подключить клиента

**Claude Code:**
```powershell
$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:20129'
$env:ANTHROPIC_API_KEY = '<API_KEY из credentials.txt>'
claude
```

**Cursor:** Settings → Models → Custom OpenAI:
- Base URL: `http://127.0.0.1:20129/v1`
- API Key: `<API_KEY>`
- Model: `claude-sonnet-4.6`, `gpt-5.2-high`, `gemini-3.0-pro`, и т.д.

**Cline / Roo / Aider** и прочие OpenAI-совместимые — то же самое.

> Cursor фильтрует имена моделей, в которых есть слово `claude`. Используй алиасы: `sonnet-4.6`, `opus-4.6`, `opus-4.7` — они работают без фильтра.

### 3. Проверить что работает

```powershell
# Модели
curl http://127.0.0.1:20129/v1/models -H "Authorization: Bearer <API_KEY>"

# Чат
curl http://127.0.0.1:20129/v1/chat/completions `
  -H "Content-Type: application/json" `
  -H "Authorization: Bearer <API_KEY>" `
  -d '{"model":"claude-sonnet-4.6","messages":[{"role":"user","content":"hi"}]}'
```

---

## Команды

| Команда | Что делает |
|---|---|
| `.\scripts\install.ps1` | Первая установка (idempotent, re-run безопасен) |
| `.\scripts\install.ps1 -Force` | Перегенерирует `.env` с новыми ключами |
| `.\scripts\start.ps1` | Запуск вручную |
| `.\scripts\stop.ps1` | Остановка |
| `.\scripts\add-account.ps1 -Token '...'` | Добавить токен через CLI |
| `.\scripts\detect-ls.ps1` | Вывести путь к Language Server |
| `.\scripts\enable-autostart.ps1` | Включить автозапуск при логине |
| `.\scripts\disable-autostart.ps1` | Выключить автозапуск |
| `.\scripts\uninstall.ps1` | Снести автозапуск + ярлык + данные |

---

## API endpoints

| Путь | Формат | Кто использует |
|---|---|---|
| `POST /v1/chat/completions` | OpenAI chat | Cursor, Cline, Aider, OpenCode |
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

## Конфиг

`.env` в корне проекта. Смотри `.env.example` для всех переменных.

- `PORT` (20129) — порт HTTP-сервера
- `HOST` (127.0.0.1) — биндинг (локал, не светится в LAN)
- `API_KEY` — ключ для клиентов
- `DASHBOARD_PASSWORD` — пароль дашборда
- `LS_BINARY_PATH` — путь к `language_server_windows_x64.exe`
- `LS_PORT` (42100) — gRPC-порт Language Server (внутренний)
- `DEFAULT_MODEL` — если клиент не передал `model`
- `LOG_LEVEL` — `debug` / `info` / `warn` / `error`
- `WINDBU_DATA_DIR` — корень данных (по умолчанию `%USERPROFILE%\.windbu`)

---

## Структура данных

```
%USERPROFILE%\.windbu\
├── accounts.json       — пул Windsurf-токенов
├── proxy.json          — proxy-настройки
├── stats.json          — usage analytics
├── runtime-config.json — experimental flags, identity prompts
├── model-access.json   — allow/block списки моделей
├── credentials.txt     — один раз при установке: API_KEY + DASHBOARD_PASSWORD
├── windbu.pid          — PID текущего процесса
├── workspace\          — временная рабочая область LS (чистится при старте)
├── ls-data\            — data-dir LS (по инстансу на прокси)
└── logs\
    ├── app-YYYY-MM-DD.jsonl
    └── error-YYYY-MM-DD.jsonl
```

---

## Troubleshooting

**`Language server binary not found`**
Установи Windsurf с официального сайта, или вручную пропиши полный путь в `.env` → `LS_BINARY_PATH`.
`detect-ls.ps1` ищет в:
- `%LOCALAPPDATA%\Programs\Windsurf\resources\app\extensions\windsurf\bin\`
- `%APPDATA%\Windsurf\bin\`
- `%LOCALAPPDATA%\Windsurf\bin\`
- `%ProgramFiles%\Windsurf\resources\app\extensions\windsurf\bin\`

**`Port 20129 already in use`**
```powershell
Get-NetTCPConnection -LocalPort 20129 | Select-Object OwningProcess
# Stop-Process -Id <pid> -Force
# или поменяй PORT в .env
```

**`No accounts available`**
Добавь хотя бы один Windsurf-токен — дашборд или `add-account.ps1`.

**Cursor не видит claude-модели**
Используй алиасы без слова "claude": `sonnet-4.6`, `opus-4.6`, `haiku-4.5`. Это фильтр самого Cursor, не windbu.

**Токен добавился, но `model_not_entitled`**
Free-аккаунт Windsurf даёт ограниченный список (в основном `gemini-2.5-flash`, `glm-4.7`). Для Claude/GPT нужен Pro-тариф.

**Процесс зомби после kill**
```powershell
.\scripts\stop.ps1
```
делает `taskkill /T /F` — сносит LS children вместе с основным процессом.

---

## Лицензия

MIT. См. [LICENSE](LICENSE) и [CREDITS.md](CREDITS.md).
