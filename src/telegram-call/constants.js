export const PLUGIN_ID = 'doubao-telegram-call';
export const REALTIME_PROVIDER_ID = 'doubao-realtime';
export const ROUTE_PREFIX = `/plugins/${PLUGIN_ID}/telegram-call`;
export const RELAY_ROUTE_PATH = `${ROUTE_PREFIX}/relay`;
export const RELAY_PROTOCOL = 'openclaw.telegram-call.relay.v1';
export const DEFAULT_PROFILE_ID = 'default';
export const DEFAULT_CALL_TOKEN_TTL_MS = 180_000;
export const DEFAULT_CALL_MAX_DURATION_SECONDS = 1_800;

export const RELAY_AUDIO_CONTRACT = Object.freeze({
  inputEncoding: 'pcm16',
  inputSampleRateHz: 24000,
  inputChannels: 1,
  inputFrameMs: 20,
  outputEncoding: 'pcm16',
  outputSampleRateHz: 24000,
  outputChannels: 1,
});
