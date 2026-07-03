# Project Boundaries

This repository is `openclaw-doubao-telegram-call`.

It only owns the Telegram Mini App realtime phone companion:

- Telegram call-card launch routes and tools
- Telegram Bot API delivery
- Mini App browser UI and audio relay client
- short-lived call tokens
- call profile selection
- OpenClaw Gateway relay handoff
- Tailscale Serve/MagicDNS phone testing documentation

It must not register, import, or package a realtime voice provider. The companion requests a provider through OpenClaw Talk `gateway-relay`.

The usual paired provider is the separate project:

```text
openclaw-doubao-realtime
```

Source: https://github.com/5R7W9/openclaw-doubao-realtime

The default provider id in call profiles is `doubao-realtime`, but this is configuration, not an implementation dependency.
