---
name: openclaw-doubao-telegram-call
description: Use when setting up, validating, launching, or debugging the OpenClaw Telegram Mini App realtime call skill/companion that depends on the Doubao realtime voice provider.
---

# OpenClaw Doubao Telegram Call

Operate this checkout as an OpenClaw skill plus companion plugin. In this package layout the plugin root is `{baseDir}/../..`; run repo commands from that root.

## Boundaries

- Keep plugin id `doubao-telegram-call`.
- Keep this project limited to Telegram Mini App launch, call profiles, relay transport, agent consult handoff, Telegram mirroring, and browser UI.
- Do not register, import, copy, or reimplement the realtime voice provider here.
- Depend on the separate `openclaw-doubao-realtime` plugin for provider id `doubao-realtime`.
- Use Tailscale Serve with MagicDNS HTTPS for phone testing. Do not use Funnel or public tunnels.
- 不要打印 token, bot token, Gateway auth token, Volcengine access key, or any local secret.

## First Run

1. Confirm the skill and both plugins are visible:

```sh
openclaw plugins install clawhub:openclaw-doubao-realtime
openclaw skills check
openclaw plugins list | rg 'doubao-realtime|doubao-telegram-call'
```

2. Confirm Gateway and phone HTTPS ingress:

```sh
openclaw config validate
openclaw gateway status
tailscale serve status
```

3. Run both package tests before claiming the setup is healthy:

```sh
cd {baseDir}/../.. && npm test
if [ -n "$OPENCLAW_DOUBAO_REALTIME_DIR" ]; then
  cd "$OPENCLAW_DOUBAO_REALTIME_DIR" && npm test
fi
```

4. Confirm `talk.catalog` sees the Doubao realtime provider without printing secrets:

```sh
cd {baseDir}/../..
node --input-type=module <<'NODE'
import fs from 'node:fs';
import { createGatewayRpcSocket } from './src/telegram-call/gateway-client.js';

const cfg = JSON.parse(fs.readFileSync(`${process.env.HOME}/.openclaw/openclaw.json`, 'utf8'));
const client = createGatewayRpcSocket({ config: cfg });
await client.connect();
const catalog = await client.request('talk.catalog', {});
client.close();
const provider = (catalog.realtime?.providers ?? []).find((entry) => entry.id === 'doubao-realtime');
console.log(JSON.stringify({
  hasDoubaoRealtime: Boolean(provider),
  configured: provider?.configured,
  transport: provider?.transports?.includes('gateway-relay') ? 'gateway-relay' : undefined,
  models: provider?.models ?? [],
  voicesCount: provider?.voices?.length ?? 0,
}, null, 2));
if (!provider?.configured) process.exitCode = 1;
NODE
```

## Required Config

Provider credentials belong to the provider plugin or Gateway environment, not this repo:

```sh
VOLCENGINE_REALTIME_APP_ID
VOLCENGINE_REALTIME_ACCESS_KEY
```

This companion selects the provider per profile:

```json
{
  "providerId": "doubao-realtime",
  "speaker": "<speaker-id>",
  "model": "1.2.1.1"
}
```

Telegram delivery can come from OpenClaw `channels.telegram.accounts` plus profile `telegramAccountId`, or from a single-account environment:

```sh
TELEGRAM_CALL_PUBLIC_BASE_URL
TELEGRAM_CALL_PROFILES_JSON
TELEGRAM_BOT_TOKEN
TELEGRAM_CALL_CHAT_ID
TELEGRAM_BOT_API_BASE_URL
TELEGRAM_CALL_CONFIG_FILE
```

Set `TELEGRAM_CALL_PUBLIC_BASE_URL` or `publicBaseUrl` to a Tailscale MagicDNS HTTPS URL such as `https://openclaw-phone.tail0000.ts.net`. Do not use a raw Tailscale IP in Telegram Mini App buttons.

Profiles map to OpenClaw agent sessions. If no `sessionKey` is supplied, the runtime derives `agent:<agentId>:<sessionId>`. Keep `profile.instructions` short; it is appended to the OpenClaw agent consult context so the agent knows the request came from a Telegram realtime call.
For a daemon Gateway, store these env vars in `~/.openclaw/.env`; workspace `.env` is only reliable for foreground runs launched from the plugin directory.

## Launch

- Use the `list_telegram_call_profiles` tool first when the target profile is unknown.
- Use `create_telegram_call_link` for a safe link-only launch during setup.
- Use `send_telegram_call_card` only when intentionally sending a Telegram DM.
- The HTTP equivalents are `/plugins/doubao-telegram-call/telegram-call/launch` and `/plugins/doubao-telegram-call/telegram-call/launch/send`.

For a local route probe, POST to `/launch` with Gateway bearer auth and print only sanitized fields: `ok`, `callId`, `profile.id`, and `url`.

## Healthy Call Signals

- Mini App logs: `page_ready`, `answer_clicked`, `mic_live`, `answer_ok`, `relay_started`, `capture_started`.
- Relay latency logs: `relay_start`, `gateway_connected`, `relay_session_created`, `first_user_audio`, `agent_consult_start`, `agent_consult_accepted`, `agent_first_delta`, `first_agent_speech_chunk`, `first_relay_audio_to_client`.
- Provider latency logs may include `asr_first_text`, `asr_final`, `asr_ended`, `first_chat_tts_text`, and `first_tts_audio`.

Check recent Gateway logs with:

```sh
journalctl --user -u openclaw-gateway.service --since '10 min ago'
```

## Common Failures

- Provider missing from `talk.catalog`: install/enable `openclaw-doubao-realtime`, then restart Gateway.
- Provider present but `configured: false`: fix `VOLCENGINE_REALTIME_APP_ID`, `VOLCENGINE_REALTIME_ACCESS_KEY`, model, and speaker in the provider config.
- Mini App button opens badly on phone: fix `publicBaseUrl` and `tailscale serve status`; Telegram needs MagicDNS HTTPS.
- Telegram send fails: verify the chosen bot was opened once in the target private chat, and prefer `telegramAccountId` over duplicated bot tokens.
- `Call expired`: generate a new call card; default tokens are intentionally short-lived.
- Answer connects then ends: inspect Gateway logs for provider auth/model/speaker errors and WebView microphone errors.

## After Changes

Run:

```sh
cd {baseDir}/../.. && npm test
openclaw skills check
openclaw plugins list | rg 'doubao-realtime|doubao-telegram-call'
```
