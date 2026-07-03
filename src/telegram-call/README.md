# Telegram Call Runtime

This folder contains the Telegram pseudo-call backend: call profiles, invite tokens, Mini App bootstrap routes, the plugin relay WebSocket, mirrored Telegram text replies, and Gateway relay session handoff.

Realtime speech is intentionally outside this folder. The relay creates an OpenClaw Talk `gateway-relay` session and asks the configured provider, usually `doubao-realtime`, to handle ASR, TTS, and barge-in. Telegram code must not import or register provider implementation.

`config-file.js` loads optional multi-agent call config from `telegram-call.config.json`, a plugin config `configFile`, or `TELEGRAM_CALL_CONFIG_FILE`. Profiles stay data-driven: add or change agents in config, not route/runtime branches.

`telegram-config.js` resolves `telegramAccountId`/`replyAccountId` against OpenClaw `channels.telegram.accounts`; call-card sends and final reply mirrors must use the same resolver so profile/account routing cannot drift.
