import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RELAY_PROTOCOL,
  TelegramCallPluginRelay,
  base64FromArrayBuffer,
  buildRelayWebSocketUrl,
  detectSpeechFromPcm16,
  pcm16Base64ToFloat32,
} from '../../web/telegram-call/relay.js';

const AUDIO = {
  inputEncoding: 'pcm16',
  inputSampleRateHz: 24000,
  inputFrameMs: 20,
  outputEncoding: 'pcm16',
  outputSampleRateHz: 24000,
};

test('builds plugin relay WebSocket URLs without Gateway auth parameters', () => {
  const url = buildRelayWebSocketUrl(new URL('https://gateway.example/plugins/doubao?gatewayToken=secret#token=gw'), {
    relayUrl: '/plugins/doubao-telegram-call/telegram-call/relay',
    callId: 'call_1',
    token: 'ctc_call_token',
    profileId: 'main',
  });

  assert.equal(url, 'wss://gateway.example/plugins/doubao-telegram-call/telegram-call/relay?callId=call_1&token=ctc_call_token&profile=main');
  assert.equal(url.includes('gatewayToken'), false);
  assert.equal(url.includes('token=gw'), false);

  assert.equal(
    buildRelayWebSocketUrl(new URL('http://127.0.0.1:41621/call'), {
      relayUrl: 'https://public.example/relay',
      callId: 'call_2',
      token: 'ctc_2',
    }),
    'wss://public.example/relay?callId=call_2&token=ctc_2',
  );
});

test('plugin relay starts from session message and sends audio frames over plugin websocket', async () => {
  FakeWebSocket.instances = [];
  const statuses = [];
  const transcripts = [];
  const relay = new TelegramCallPluginRelay({
    bootstrap: makeBootstrap(),
    callId: 'call_1',
    token: 'ctc_1',
    profileId: 'main',
    location: new URL('https://gateway.example/call'),
    WebSocketCtor: FakeWebSocket,
    AudioContextCtor: FakeAudioContext,
    onStatus: (kind, detail) => statuses.push({ kind, detail }),
    onTranscript: (entry) => transcripts.push(entry),
  });

  const starting = relay.start();
  await tick();
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.url, 'wss://gateway.example/plugins/doubao-telegram-call/telegram-call/relay?callId=call_1&token=ctc_1&profile=main');

  socket.serverMessage({
    protocol: RELAY_PROTOCOL,
    type: 'session',
    session: { relaySessionId: 'relay-1', audio: AUDIO },
    audio: AUDIO,
  });
  assert.equal((await starting).relaySessionId, 'relay-1');
  assert.equal(relay.relaySessionId, 'relay-1');
  assert.equal(statuses.at(-1).kind, 'relay_ready');
  assert.equal(relay.outputContext.options.sampleRate, undefined);

  relay.appendAudioFrame({
    pcm16: new Int16Array([1, 2]).buffer,
    timestamp: 42,
  });
  assert.deepEqual(socket.sent.at(-1), {
    protocol: RELAY_PROTOCOL,
    type: 'audio',
    audioBase64: 'AQACAA==',
    timestamp: 42,
  });

  socket.serverMessage({
    protocol: RELAY_PROTOCOL,
    type: 'relayEvent',
    event: {
      relaySessionId: 'relay-1',
      type: 'transcript',
      role: 'assistant',
      text: 'hello',
      final: true,
    },
  });
  assert.deepEqual(transcripts.at(-1), {
    role: 'assistant',
    text: 'hello',
    final: true,
  });

  await relay.stop();
  assert.deepEqual(socket.sent.at(-1), {
    protocol: RELAY_PROTOCOL,
    type: 'hangup',
  });
  assert.equal(socket.closed, true);
});

test('plugin relay ignores non-plugin messages and debounces barge-in cancel locally', async () => {
  FakeWebSocket.instances = [];
  const errors = [];
  const outputQueue = {
    isPlaying: true,
    playCalls: [],
    stopCalls: 0,
    play(audioBase64) {
      this.playCalls.push(audioBase64);
    },
    stop() {
      this.stopCalls += 1;
    },
  };
  const relay = new TelegramCallPluginRelay({
    bootstrap: makeBootstrap(),
    callId: 'call_1',
    token: 'ctc_1',
    location: new URL('https://gateway.example/call'),
    WebSocketCtor: FakeWebSocket,
    AudioContextCtor: FakeAudioContext,
    outputQueue,
    onError: (error) => errors.push(error),
  });

  const starting = relay.start();
  await tick();
  const socket = FakeWebSocket.instances[0];
  socket.serverMessage({ type: 'error', code: 'wrong_protocol', message: 'ignore me' });
  assert.equal(errors.length, 0);
  socket.serverMessage({
    protocol: RELAY_PROTOCOL,
    type: 'session',
    session: { relaySessionId: 'relay-1', audio: AUDIO },
    audio: AUDIO,
  });
  await starting;

  const speech = new Int16Array(480).fill(6000).buffer;
  relay.appendAudioFrame({ pcm16: speech, timestamp: 1 });
  relay.appendAudioFrame({ pcm16: speech, timestamp: 2 });

  assert.equal(outputQueue.stopCalls, 0);
  assert.equal(socket.sent.some((message) => message.type === 'cancelOutput'), false);

  for (let timestamp = 3; timestamp <= 8; timestamp += 1) {
    relay.appendAudioFrame({ pcm16: speech, timestamp });
  }

  assert.equal(outputQueue.stopCalls, 1);
  assert.deepEqual(socket.sent.find((message) => message.type === 'cancelOutput'), {
    protocol: RELAY_PROTOCOL,
    type: 'cancelOutput',
    reason: 'barge-in',
  });
});

test('plugin relay reports playback start on the first output audio frame', async () => {
  FakeWebSocket.instances = [];
  const playbackMarks = [];
  const outputQueue = {
    isPlaying: false,
    playCalls: [],
    play(audioBase64) {
      this.playCalls.push(audioBase64);
      this.isPlaying = true;
    },
    stop() {
      this.isPlaying = false;
    },
  };
  const relay = new TelegramCallPluginRelay({
    bootstrap: makeBootstrap(),
    callId: 'call_1',
    token: 'ctc_1',
    location: new URL('https://gateway.example/call'),
    WebSocketCtor: FakeWebSocket,
    AudioContextCtor: FakeAudioContext,
    outputQueue,
    onPlaybackStart: (entry) => playbackMarks.push(entry),
  });

  const starting = relay.start();
  await tick();
  const socket = FakeWebSocket.instances[0];
  socket.serverMessage({
    protocol: RELAY_PROTOCOL,
    type: 'session',
    session: { relaySessionId: 'relay-1', audio: AUDIO },
    audio: AUDIO,
  });
  await starting;

  socket.serverMessage({
    protocol: RELAY_PROTOCOL,
    type: 'relayEvent',
    event: {
      relaySessionId: 'relay-1',
      type: 'audio',
      audioBase64: 'AQACAA==',
    },
  });
  socket.serverMessage({
    protocol: RELAY_PROTOCOL,
    type: 'relayEvent',
    event: {
      relaySessionId: 'relay-1',
      type: 'audio',
      audioBase64: 'AwAEAA==',
    },
  });

  assert.deepEqual(outputQueue.playCalls, ['AQACAA==', 'AwAEAA==']);
  assert.deepEqual(playbackMarks, [{
    callId: 'call_1',
    profileId: undefined,
    relaySessionId: 'relay-1',
  }]);
});

test('plugin relay treats aborted OpenClaw tool calls as recoverable', async () => {
  FakeWebSocket.instances = [];
  const statuses = [];
  const errors = [];
  const relay = new TelegramCallPluginRelay({
    bootstrap: makeBootstrap(),
    callId: 'call_1',
    token: 'ctc_1',
    location: new URL('https://gateway.example/call'),
    WebSocketCtor: FakeWebSocket,
    AudioContextCtor: FakeAudioContext,
    onStatus: (kind, detail) => statuses.push({ kind, detail }),
    onError: (error) => errors.push(error),
  });

  const starting = relay.start();
  await tick();
  const socket = FakeWebSocket.instances[0];
  socket.serverMessage({
    protocol: RELAY_PROTOCOL,
    type: 'session',
    session: { relaySessionId: 'relay-1', audio: AUDIO },
    audio: AUDIO,
  });
  await starting;

  socket.serverMessage({
    protocol: RELAY_PROTOCOL,
    type: 'relayEvent',
    event: {
      relaySessionId: 'relay-1',
      type: 'error',
      message: 'OpenClaw tool call aborted',
    },
  });

  assert.equal(errors.length, 0);
  assert.deepEqual(statuses.at(-1), {
    kind: 'tool_call_aborted',
    detail: 'OpenClaw tool call aborted',
  });
  assert.equal(relay.closed, false);
});

test('plugin relay treats top-level aborted tool call errors as recoverable', async () => {
  FakeWebSocket.instances = [];
  const statuses = [];
  const errors = [];
  const relay = new TelegramCallPluginRelay({
    bootstrap: makeBootstrap(),
    callId: 'call_1',
    token: 'ctc_1',
    location: new URL('https://gateway.example/call'),
    WebSocketCtor: FakeWebSocket,
    AudioContextCtor: FakeAudioContext,
    onStatus: (kind, detail) => statuses.push({ kind, detail }),
    onError: (error) => errors.push(error),
  });

  const starting = relay.start();
  await tick();
  const socket = FakeWebSocket.instances[0];
  socket.serverMessage({
    protocol: RELAY_PROTOCOL,
    type: 'session',
    session: { relaySessionId: 'relay-1', audio: AUDIO },
    audio: AUDIO,
  });
  await starting;

  socket.serverMessage({
    protocol: RELAY_PROTOCOL,
    type: 'error',
    code: 'tool_call_failed',
    message: 'OpenClaw tool call aborted',
  });

  assert.equal(errors.length, 0);
  assert.deepEqual(statuses.at(-1), {
    kind: 'tool_call_aborted',
    detail: 'OpenClaw tool call aborted',
  });
  assert.equal(relay.closed, false);
});

test('encodes PCM frames and detects speech for barge-in', () => {
  const pcm = new Int16Array([0, 32767, -32768]);
  const base64 = base64FromArrayBuffer(pcm.buffer);
  const floats = pcm16Base64ToFloat32(base64);

  assert.equal(floats.length, 3);
  assert.equal(floats[0], 0);
  assert.ok(floats[1] > 0.99);
  assert.equal(floats[2], -1);

  assert.equal(detectSpeechFromPcm16(new Int16Array(480).fill(4000).buffer).speech, true);
  assert.equal(detectSpeechFromPcm16(new Int16Array(480).fill(100).buffer).speech, false);
});

function makeBootstrap() {
  return {
    pluginRelay: {
      url: '/plugins/doubao-telegram-call/telegram-call/relay',
      protocol: RELAY_PROTOCOL,
      audio: AUDIO,
    },
  };
}

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.emit('open', {});
    });
  }

  addEventListener(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close(code = 1000, reason = '') {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', { code, reason });
  }

  serverMessage(frame) {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  emit(event, payload) {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

class FakeAudioContext {
  constructor(options = {}) {
    this.options = options;
    this.currentTime = 0;
    this.destination = {};
    this.closed = false;
  }

  async resume() {}

  async close() {
    this.closed = true;
  }

  createBuffer(_channels, length, sampleRate) {
    const data = new Float32Array(length);
    return {
      duration: length / sampleRate,
      getChannelData: () => data,
    };
  }

  createBufferSource() {
    return {
      addEventListener() {},
      connect() {},
      start() {},
      stop() {},
    };
  }
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
