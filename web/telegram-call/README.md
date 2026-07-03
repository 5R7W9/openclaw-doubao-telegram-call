# Telegram Mini App Call UI

This folder contains the Telegram Mini App call surface: answer, hang up, mute, audio device state, and relay bootstrap UI.

The UI connects only to the plugin relay WebSocket with the short-lived call token. The plugin relay owns the backend OpenClaw Gateway connection. Low-latency model audio is owned by whichever OpenClaw Talk provider the call profile selects, usually the separate `doubao-realtime` provider plugin.

The current shell is localized Chinese and intentionally styled as a black/white 1-bit retro gothic phone surface. It uses plugin-local font files and a profile-driven avatar slot:

- `avatarUrl`: image shown in the center portrait frame.
- `avatarText`: short fallback mark when no image is configured or the image fails to load.

Keep future UI work lightweight and WebView-safe: no frontend framework, no public assets, no large bundles, and no extra audio buffering.
