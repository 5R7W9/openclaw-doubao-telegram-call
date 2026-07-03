# OpenClaw Doubao Telegram Call

Telegram Mini App realtime phone companion for OpenClaw Talk.

This project owns the Telegram side only: call-card launch, Mini App assets, short-lived call tokens, profile routing, relay routes, Telegram Bot API delivery, and Tailscale phone testing notes. It does not register or package a realtime voice provider.

For Doubao voice, install and configure the separate provider project:

```sh
openclaw plugins install clawhub:openclaw-doubao-realtime
```

Source: https://github.com/5R7W9/openclaw-doubao-realtime

The companion defaults call profiles to `providerId: "doubao-realtime"` because that is the provider requested through OpenClaw Talk `gateway-relay`.

## Requirements

- OpenClaw Gateway `>=2026.6.8`
- A configured OpenClaw Talk realtime provider, usually `doubao-realtime`
- Telegram bot/account config for sending Mini App call cards
- Tailscale Serve with HTTPS MagicDNS for real phone Telegram Mini App testing

## Install

Install from ClawHub when published:

```sh
openclaw plugins install clawhub:openclaw-doubao-telegram-call
```

For local development, load this checkout as an OpenClaw code plugin.

Keep these package surfaces:

- `index.js`
- `LICENSE`
- `.env.example`
- `openclaw.plugin.json`
- `src/telegram-call/`
- `src/values.js`
- `web/telegram-call/`
- `skills/openclaw-doubao-telegram-call/`
- `telegram-call.config.example.json`

## Configure

Copy the env and local profile templates:

```sh
cp .env.example .env
cp telegram-call.config.example.json telegram-call.config.json
```

`telegram-call.config.json` is ignored because it can contain local profile choices, private chat ids, avatar URLs, or bot routing details.
For a daemon-managed Gateway, put runtime env vars in `~/.openclaw/.env`; workspace `.env` is mainly for foreground runs from this directory.

Minimal OpenClaw plugin config shape:

```json
{
  "plugins": {
    "entries": {
      "doubao-telegram-call": {
        "enabled": true,
        "config": {
          "publicBaseUrl": "https://openclaw-phone.tail0000.ts.net",
          "defaultProfile": "main",
          "callProfiles": {
            "main": {
              "label": "OpenClaw",
              "agentId": "main",
              "sessionKey": "agent:main:main",
              "providerId": "doubao-realtime",
              "speaker": "<doubao-speaker-id>",
              "model": "1.2.1.1",
              "telegramAccountId": "default",
              "avatarText": "OC"
            }
          }
        }
      }
    }
  }
}
```

Telegram delivery can come from OpenClaw `channels.telegram.accounts` through `telegramAccountId`, or from server-side env:

```sh
export TELEGRAM_CALL_PUBLIC_BASE_URL="https://openclaw-phone.tail0000.ts.net"
export TELEGRAM_CALL_PROFILES_JSON='{"main":{"label":"OpenClaw","agentId":"main","sessionKey":"agent:main:main","speaker":"<doubao-speaker-id>","model":"1.2.1.1","telegramAccountId":"default"}}'
export TELEGRAM_BOT_TOKEN="<telegram-bot-token>"
export TELEGRAM_CALL_CHAT_ID="<private-chat-id>"
```

Optional env:

```sh
export TELEGRAM_CALL_BUTTON_TEXT="接听"
export TELEGRAM_CALL_MESSAGE_TEXT="来自 {label} 的语音来电"
export TELEGRAM_CALL_DISABLE_NOTIFICATION="false"
export TELEGRAM_BOT_API_BASE_URL="https://api.telegram.org"
export TELEGRAM_CALL_ACCOUNT_ID="default"
export TELEGRAM_CALL_MIRROR_REPLIES="false"
export TELEGRAM_CALL_CONFIG_FILE="/absolute/path/to/telegram-call.config.json"
```

## Routes

- `GET /plugins/doubao-telegram-call/telegram-call/`
- `GET /plugins/doubao-telegram-call/telegram-call/assets/...`
- `POST /plugins/doubao-telegram-call/telegram-call/launch`
- `POST /plugins/doubao-telegram-call/telegram-call/launch/send`
- `POST /plugins/doubao-telegram-call/telegram-call/answer`
- `POST /plugins/doubao-telegram-call/telegram-call/hangup`
- `POST /plugins/doubao-telegram-call/telegram-call/client-log`
- `WS /plugins/doubao-telegram-call/telegram-call/relay`

## How It Works

1. `/launch` or `/launch/send` creates a pending call with a short-lived token.
2. The Telegram call card opens the Mini App URL over HTTPS.
3. The Mini App calls `/answer`, requests microphone access, and opens the plugin relay WebSocket.
4. The plugin relay creates an OpenClaw Talk `gateway-relay` session using the selected profile.
5. Browser audio flows through the companion relay into OpenClaw Talk.
6. The configured realtime provider handles ASR/TTS and interruption.
7. Agent text replies can be mirrored back to Telegram without blocking speech.

## Tailscale Phone Testing

Real Telegram Mini App phone testing requires HTTPS. Use Tailscale Serve with MagicDNS and keep the Gateway bound to loopback. Do not use Funnel or a public tunnel for this companion.

Example `publicBaseUrl`:

```text
https://openclaw-phone.tail0000.ts.net
```

Do not use a raw Tailscale IP in Telegram Mini App buttons; Telegram Mini Apps need HTTPS.

## Diagnostics

Run tests:

```sh
npm test
```

Send a call card through a running Gateway:

```sh
node --input-type=module <<'NODE'
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, 'utf8'));
const port = cfg.gateway?.port ?? 41621;
const token = cfg.gateway?.auth?.token;
if (!token) throw new Error('Missing OpenClaw Gateway token in local config');

const res = await fetch(`http://127.0.0.1:${port}/plugins/doubao-telegram-call/telegram-call/launch/send`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ profileId: 'main' }),
});
const json = await res.json();
console.log(JSON.stringify({
  ok: json.ok,
  callId: json.callId,
  profile: json.profile?.id,
  telegram: json.telegram,
  url: json.url,
  code: json.code,
  message: json.message,
}, null, 2));
if (!res.ok || json.ok !== true) process.exitCode = 1;
NODE
```

Useful logs:

```sh
journalctl --user -u openclaw-gateway.service --since '10 min ago' | rg 'doubao-telegram-call|relay_status|answer|hangup|mic_live|capture|speaking'
```

Latency trace:

```sh
journalctl --user -u openclaw-gateway.service --since '10 min ago' | rg 'doubao-telegram-call/(latency|client)|first_user_audio|asr_first_text|asr_final|agent_consult|agent_first_delta|first_agent_speech_chunk|first_relay_audio_to_client|playback_started'
```

## Security

- Telegram bot tokens, Gateway tokens, and provider credentials stay server-side.
- The Mini App receives only a call id, short-lived call token, profile id, and relay bootstrap data.
- Do not commit `.env` or `telegram-call.config.json`.
