# Credits

windbu is a Windows-focused fork built on the shoulders of two open-source projects:

## Upstream

- **[guanxiaol/WindsurfPoolAPI](https://github.com/guanxiaol/WindsurfPoolAPI)** — MIT.
  Source of the multi-account pool implementation, dashboard SPA, account
  manager, analytics, handlers for `/v1/chat/completions`, `/v1/messages`,
  `/v1/responses`, tool emulation, and the entire Language Server pool.

- **[dwgx/WindsurfAPI](https://github.com/dwgx/WindsurfAPI)** — MIT.
  Original Windsurf-to-OpenAI proxy work that `WindsurfPoolAPI` extends.
  Reverse-engineered gRPC protocol, protobuf encoders, Cascade session reuse,
  identity masking, sanitize pipeline.

## Inspiration

- **[decolua/9router](https://github.com/decolua/9router)** — MIT.
  Informed the UX design for `windbu`: local gateway with one API key for
  many accounts, dashboard-driven account management, streaming-first
  handling, cross-client compatibility.

## What windbu changes

windbu is narrowly focused. It keeps the hard parts (LS pool, protobuf, Cascade
protocol translation, account logic) **as-is** from upstream and only swaps:

- Brand strings (name, banner, dashboard title, headers)
- Hardcoded Unix paths (`/tmp/...`, `/opt/...`, `process.cwd()/foo.json`)
  centralized into `config.dataDir` so everything lands under
  `%USERPROFILE%\.windbu\`
- Language Server spawn hardened for Windows (`windowsHide:true`, `taskkill /T /F`
  for teardown, no `HOME=/root` fallback)
- Bind target default `127.0.0.1` (not `0.0.0.0`) to avoid LAN exposure
- PowerShell installer + start/stop/autostart/uninstall helpers
- Preflight checks (Node version, port availability, data dir writable,
  LS binary reachable) with actionable error messages

No upstream business logic was rewritten.

## License

All files inherited from upstream carry the MIT license and retain it.
windbu's own additions (PowerShell scripts, `preflight.js`, README, CREDITS)
are also MIT.
