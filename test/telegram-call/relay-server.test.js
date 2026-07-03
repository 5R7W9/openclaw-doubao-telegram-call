import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createTelegramCallRuntime,
} from '../../src/telegram-call/runtime.js';
import {
  GatewayRpcSocket,
  buildBackendGatewayConnectParams,
  resolveGatewayWsUrl,
} from '../../src/telegram-call/gateway-client.js';
import {
  createTelegramCallRelaySession,
  parseRelayRequestUrl,
} from '../../src/telegram-call/relay.js';

test('backend Gateway connect params use official backend client shape', () => {
  const params = buildBackendGatewayConnectParams({
    auth: { token: 'secret-token' },
  });

  assert.equal(params.minProtocol, 4);
  assert.equal(params.maxProtocol, 4);
  assert.deepEqual(params.client, {
    id: 'gateway-client',
    displayName: 'Telegram Call Relay',
    version: 'doubao-telegram-call/0.1.0',
    platform: 'node',
    mode: 'backend',
  });
  assert.equal(params.role, 'operator');
  assert.deepEqual(params.scopes, ['operator.write']);
  assert.deepEqual(params.auth, { token: 'secret-token' });
});

test('backend Gateway URL follows OpenClaw Gateway port environment', () => {
  assert.equal(
    resolveGatewayWsUrl({}, { OPENCLAW_GATEWAY_PORT: '41621' }),
    'ws://127.0.0.1:41621/',
  );
  assert.equal(
    resolveGatewayWsUrl({ gateway: { port: 5555 } }, {}),
    'ws://127.0.0.1:5555/',
  );
  assert.equal(
    resolveGatewayWsUrl({}, { OPENCLAW_GATEWAY_URL: 'ws://gateway.example/' }),
    'ws://gateway.example/',
  );
});

test('Gateway RPC socket sends connect after WebSocket open without waiting for challenge', async () => {
  FakeGatewayWebSocket.instances = [];
  const client = new GatewayRpcSocket({
    url: 'ws://127.0.0.1:41621/',
    auth: { token: 'secret-token' },
    WebSocketCtor: FakeGatewayWebSocket,
    connectTimeoutMs: 1000,
  });

  const connecting = client.connect();
  await tick();
  const socket = FakeGatewayWebSocket.instances[0];
  assert.equal(socket.url, 'ws://127.0.0.1:41621/');
  assert.equal(socket.sent[0].method, 'connect');
  assert.equal(socket.sent[0].params.client.id, 'gateway-client');

  socket.serverMessage({
    type: 'res',
    id: socket.sent[0].id,
    ok: true,
    payload: {
      server: { connId: 'conn-1' },
      auth: { scopes: ['operator.write'] },
    },
  });

  assert.deepEqual(await connecting, {
    server: { connId: 'conn-1' },
    auth: { scopes: ['operator.write'] },
  });
  client.close();
});

test('relay request parser extracts opaque call token fields', () => {
  const parsed = parseRelayRequestUrl('/plugins/doubao-telegram-call/telegram-call/relay?callId=call_1&token=ctc_abc&profile=main');

  assert.deepEqual(parsed, {
    callId: 'call_1',
    token: 'ctc_abc',
    profileId: 'main',
  });
});

test('relay session creates Gateway Talk relay and forwards audio/events on one backend client', async () => {
  const runtime = createTelegramCallRuntime({
    config: {
      defaultProfile: 'secondary',
      callProfiles: {
        secondary: {
          label: 'Logan',
          agentId: 'secondary-agent',
          speaker: 'S_secondary',
          model: '2.2.0.0',
        },
      },
    },
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
  });
  const launch = runtime.createCall({ profileId: 'secondary' });
  runtime.answerCall({ callId: launch.callId, token: launch.token, profileId: 'secondary' });
  const gateway = new FakeGatewayClient();
  const client = new FakeSocket();

  const session = createTelegramCallRelaySession({
    runtime,
    gatewayClientFactory: () => gateway,
  });
  await session.start(client, {
    callId: launch.callId,
    token: launch.token,
    profileId: 'secondary',
  });

  assert.equal(gateway.connectCount, 1);
  assert.equal(gateway.requests[0].method, 'talk.session.create');
  assert.equal(gateway.requests[0].params.sessionKey, 'agent:secondary-agent:main');
  assert.equal(gateway.requests[0].params.provider, 'doubao-realtime');
  assert.equal(gateway.requests[0].params.voice, 'S_secondary');
  assert.equal(gateway.requests[0].params.model, '2.2.0.0');
  assert.deepEqual(client.sent.at(-1), {
    protocol: 'openclaw.telegram-call.relay.v1',
    type: 'session',
    call: {
      callId: launch.callId,
      profileId: 'secondary',
      label: 'Logan',
      state: 'active',
      expiresAt: 181,
      answeredAt: 1,
      maxDurationSeconds: 1800,
    },
    session: {
      relaySessionId: 'relay-1',
      sessionId: 'relay-1',
      audio: {
        inputEncoding: 'pcm16',
        inputSampleRateHz: 24000,
        outputEncoding: 'pcm16',
        outputSampleRateHz: 24000,
      },
    },
    audio: {
      inputEncoding: 'pcm16',
      inputSampleRateHz: 24000,
      outputEncoding: 'pcm16',
      outputSampleRateHz: 24000,
    },
  });

  client.emitJson({ type: 'audio', audioBase64: 'AAAA', timestamp: 42 });
  assert.equal(gateway.requests[1].method, 'talk.session.appendAudio');
  assert.deepEqual(gateway.requests[1].params, {
    sessionId: 'relay-1',
    audioBase64: 'AAAA',
    timestamp: 42,
  });

  gateway.emitEvent({
    event: 'talk.event',
    payload: {
      relaySessionId: 'relay-1',
      type: 'ready',
    },
  });
  assert.deepEqual(client.sent.at(-1), {
    protocol: 'openclaw.telegram-call.relay.v1',
    type: 'relayEvent',
    event: {
      relaySessionId: 'relay-1',
      type: 'ready',
    },
  });

  client.emit('close');
  await waitFor(() => gateway.closed === true);
  assert.equal(gateway.requests.at(-1).method, 'talk.session.close');
  assert.deepEqual(gateway.requests.at(-1).params, { sessionId: 'relay-1' });
  assert.equal(gateway.closed, true);
});

test('relay session notifies the agent once when the call hangs up', async () => {
  const runtime = createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
  });
  const launch = runtime.createCall({});
  runtime.answerCall({ callId: launch.callId, token: launch.token });
  const gateway = new FakeGatewayClient();
  const client = new FakeSocket();
  const session = createTelegramCallRelaySession({
    runtime,
    gatewayClientFactory: () => gateway,
  });
  await session.start(client, {
    callId: launch.callId,
    token: launch.token,
  });

  client.emitJson({ type: 'hangup' });
  client.emit('close');

  await waitFor(() => gateway.closed === true);
  const notifications = gateway.requests.filter((request) => request.method === 'chat.send');
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0].params, {
    sessionKey: 'agent:main:main',
    message: '电话已挂断。',
    deliver: false,
    idempotencyKey: `telegram-call-hangup:${launch.callId}`,
  });
  const methods = gateway.requests.map((request) => request.method);
  assert.deepEqual(methods.slice(-2), ['chat.send', 'talk.session.close']);
});

test('relay session logs latency marks for first client audio and agent consult milestones', async () => {
  const runtime = createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
  });
  const launch = runtime.createCall({});
  runtime.answerCall({ callId: launch.callId, token: launch.token });
  const gateway = new FakeGatewayClient();
  const client = new FakeSocket();
  const latencyLogs = [];
  const session = createTelegramCallRelaySession({
    runtime,
    gatewayClientFactory: () => gateway,
    logger: {
      warn: (line) => {
        if (String(line).includes('[doubao-telegram-call/latency]')) {
          latencyLogs.push(JSON.parse(String(line).slice(String(line).indexOf('{'))));
        }
      },
    },
    now: createIncrementingClock(1000, 25),
  });
  await session.start(client, {
    callId: launch.callId,
    token: launch.token,
  });

  client.emitJson({ type: 'audio', audioBase64: 'AAAA', timestamp: 42 });
  gateway.emitEvent({
    event: 'talk.event',
    payload: {
      relaySessionId: 'relay-1',
      type: 'toolCall',
      callId: 'tool-latency-1',
      name: 'openclaw_agent_consult',
      args: { question: 'hello' },
    },
  });
  await waitFor(() => gateway.requests.some((request) => request.method === 'talk.client.toolCall'));
  gateway.emitEvent({
    event: 'chat',
    payload: {
      runId: 'run-1',
      state: 'delta',
      message: { text: '第一句已经可以先说。' },
    },
  });
  await waitFor(() => gateway.requests.some((request) => request.params?.result?.streamSpeech === true));

  assert.deepEqual(latencyLogs.map((entry) => entry.mark), [
    'relay_start',
    'gateway_connected',
    'relay_session_created',
    'first_user_audio',
    'emotion_not_ready',
    'agent_consult_start',
    'agent_consult_accepted',
    'agent_first_delta',
    'first_agent_speech_chunk',
  ]);
  assert.equal(latencyLogs[0].callId, launch.callId);
  assert.equal(latencyLogs.at(-1).relaySessionId, 'relay-1');
  assert.equal(typeof latencyLogs.at(-1).sinceStartMs, 'number');
});

test('relay session logs provider ASR latency marks once per turn index', async () => {
  const runtime = createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
  });
  const launch = runtime.createCall({});
  runtime.answerCall({ callId: launch.callId, token: launch.token });
  const gateway = new FakeGatewayClient();
  const client = new FakeSocket();
  const latencyLogs = [];
  const session = createTelegramCallRelaySession({
    runtime,
    gatewayClientFactory: () => gateway,
    logger: {
      warn: (line) => {
        if (String(line).includes('[doubao-telegram-call/latency]')) {
          latencyLogs.push(JSON.parse(String(line).slice(String(line).indexOf('{'))));
        }
      },
    },
    now: createIncrementingClock(2000, 10),
  });
  await session.start(client, {
    callId: launch.callId,
    token: launch.token,
  });

  gateway.emitEvent({
    event: 'talk.event',
    payload: {
      relaySessionId: 'relay-1',
      type: 'latency',
      mark: 'asr_final',
      source: 'provider',
      turnIndex: 1,
      textChars: 4,
    },
  });
  gateway.emitEvent({
    event: 'talk.event',
    payload: {
      relaySessionId: 'relay-1',
      type: 'latency',
      mark: 'asr_final',
      source: 'provider',
      turnIndex: 2,
      textChars: 8,
    },
  });
  gateway.emitEvent({
    event: 'talk.event',
    payload: {
      relaySessionId: 'relay-1',
      type: 'latency',
      mark: 'asr_final',
      source: 'provider',
      turnIndex: 2,
      textChars: 8,
    },
  });

  const asrFinals = latencyLogs.filter((entry) => entry.mark === 'asr_final');
  assert.deepEqual(asrFinals.map((entry) => entry.turnIndex), [1, 2]);
  assert.deepEqual(asrFinals.map((entry) => entry.textChars), [4, 8]);
});

test('relay session logs first relay audio once per provider turn index', async () => {
  const runtime = createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
  });
  const launch = runtime.createCall({});
  runtime.answerCall({ callId: launch.callId, token: launch.token });
  const gateway = new FakeGatewayClient();
  const client = new FakeSocket();
  const latencyLogs = [];
  const session = createTelegramCallRelaySession({
    runtime,
    gatewayClientFactory: () => gateway,
    logger: {
      warn: (line) => {
        if (String(line).includes('[doubao-telegram-call/latency]')) {
          latencyLogs.push(JSON.parse(String(line).slice(String(line).indexOf('{'))));
        }
      },
    },
    now: createIncrementingClock(3000, 10),
  });
  await session.start(client, {
    callId: launch.callId,
    token: launch.token,
  });

  gateway.emitEvent({
    event: 'talk.event',
    payload: {
      relaySessionId: 'relay-1',
      type: 'latency',
      mark: 'first_tts_audio',
      source: 'provider',
      turnIndex: 1,
      audioBytes: 128,
    },
  });
  gateway.emitEvent({
    event: 'talk.event',
    payload: {
      relaySessionId: 'relay-1',
      type: 'audio',
      audioBase64: 'AAAA',
    },
  });
  gateway.emitEvent({
    event: 'talk.event',
    payload: {
      relaySessionId: 'relay-1',
      type: 'latency',
      mark: 'first_tts_audio',
      source: 'provider',
      turnIndex: 2,
      audioBytes: 256,
    },
  });
  gateway.emitEvent({
    event: 'talk.event',
    payload: {
      relaySessionId: 'relay-1',
      type: 'audio',
      audioBase64: 'BBBB',
    },
  });

  const relayAudio = latencyLogs.filter((entry) => entry.mark === 'first_relay_audio_to_client');
  assert.deepEqual(relayAudio.map((entry) => entry.turnIndex), [1, 2]);
  assert.deepEqual(relayAudio.map((entry) => entry.audioBase64Chars), [4, 4]);
});

test('relay session handles OpenClaw agent consult tool calls on backend Gateway client', async () => {
  const runtime = createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
  });
  const launch = runtime.createCall({});
  runtime.answerCall({ callId: launch.callId, token: launch.token });
  const gateway = new FakeGatewayClient();
  const client = new FakeSocket();
  const session = createTelegramCallRelaySession({
    runtime,
    gatewayClientFactory: () => gateway,
  });
  await session.start(client, {
    callId: launch.callId,
    token: launch.token,
  });

  gateway.emitEvent({
    event: 'talk.event',
    payload: {
      relaySessionId: 'relay-1',
      type: 'toolCall',
      callId: 'tool-1',
      name: 'openclaw_agent_consult',
      args: { question: 'hello' },
    },
  });
  await Promise.resolve();
  assert.equal(gateway.requests.at(-1).method, 'talk.client.toolCall');
  assert.deepEqual(gateway.requests.at(-1).params, {
    sessionKey: 'agent:main:main',
    callId: 'tool-1',
    name: 'openclaw_agent_consult',
    args: { question: 'hello' },
    relaySessionId: 'relay-1',
  });

  gateway.emitEvent({
    event: 'chat',
    payload: {
      runId: 'run-1',
      state: 'final',
      message: { text: 'Hi from OpenClaw' },
    },
  });
  await waitFor(() => gateway.requests.filter((request) => request.method === 'talk.session.submitToolResult').length >= 2);
  const submits = gateway.requests.filter((request) => request.method === 'talk.session.submitToolResult');
  assert.deepEqual(submits[0].params, {
    sessionId: 'relay-1',
    callId: 'tool-1',
    result: {
      text: 'Hi from OpenClaw',
      streamSpeech: true,
    },
    options: { willContinue: true },
  });
  assert.deepEqual(submits.at(-1).params, {
    sessionId: 'relay-1',
    callId: 'tool-1',
    result: {
      status: 'already_delivered',
      streamSpeechEnd: true,
    },
    options: { suppressResponse: true },
  });
});

test('relay session adds profile instructions to OpenClaw agent consult context', async () => {
  const runtime = createTelegramCallRuntime({
    config: {
      callProfiles: {
        main: {
          label: 'Main',
          instructions: '来自 Telegram 实时通话。',
        },
      },
    },
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
  });
  const launch = runtime.createCall({});
  runtime.answerCall({ callId: launch.callId, token: launch.token });
  const gateway = new FakeGatewayClient();
  const client = new FakeSocket();
  const session = createTelegramCallRelaySession({
    runtime,
    gatewayClientFactory: () => gateway,
  });
  await session.start(client, {
    callId: launch.callId,
    token: launch.token,
  });

  gateway.emitEvent({
    event: 'talk.event',
    payload: {
      relaySessionId: 'relay-1',
      type: 'toolCall',
      callId: 'tool-instructions',
      name: 'openclaw_agent_consult',
      args: { question: 'hello', context: '情绪：开心' },
    },
  });

  await waitFor(() => gateway.requests.some((request) => request.method === 'talk.client.toolCall'));
  const request = gateway.requests.find((entry) => entry.method === 'talk.client.toolCall');
  assert.deepEqual(request.params.args, {
    question: 'hello',
    context: '情绪：开心\n来自 Telegram 实时通话。',
  });
});

test('relay session mirrors final agent text to the profile Telegram account', async () => {
  const runtime = createTelegramCallRuntime({
    config: {
      callProfiles: {
        support: {
          label: 'Support Agent',
          agentId: 'support',
          sessionKey: 'agent:support:main',
          speaker: 'zh_male_lanyinmianbao_uranus_bigtts',
          telegramAccountId: 'support',
        },
      },
    },
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
  });
  const launch = runtime.createCall({
    profileId: 'support',
    chatId: 1234567890,
  });
  runtime.answerCall({ callId: launch.callId, token: launch.token, profileId: 'support' });
  const gateway = new FakeGatewayClient();
  const client = new FakeSocket();
  const sentText = [];
  const session = createTelegramCallRelaySession({
    runtime,
    config: {
      channels: {
        telegram: {
          accounts: {
            default: {
              botToken: 'primary-token',
              defaultTo: 1234567890,
            },
            support: {
              botToken: 'support-token',
              defaultTo: 1234567890,
            },
          },
        },
      },
    },
    gatewayClientFactory: () => gateway,
    telegramTextSender: async (params) => {
      sentText.push(params);
      return { messageId: 22, chatId: 1234567890 };
    },
  });
  await session.start(client, {
    callId: launch.callId,
    token: launch.token,
    profileId: 'support',
  });

  gateway.emitEvent({
    event: 'talk.event',
    payload: {
      relaySessionId: 'relay-1',
      type: 'toolCall',
      callId: 'tool-support',
      name: 'openclaw_agent_consult',
      args: { question: 'hello' },
    },
  });
  await waitFor(() => gateway.requests.some((request) => request.method === 'talk.client.toolCall'));

  gateway.emitEvent({
    event: 'chat',
    payload: {
      runId: 'run-1',
      state: 'final',
      message: { text: '蘑菇回复。' },
    },
  });

  await waitFor(() => sentText.length === 1);
  const submit = gateway.requests.find((request) => request.method === 'talk.session.submitToolResult');
  assert.equal(submit.params.result.text, '蘑菇回复。');
  assert.equal(sentText[0].text, '蘑菇回复。');
  assert.equal(sentText[0].config.accountId, 'support');
  assert.equal(sentText[0].config.botToken, 'support-token');
  assert.equal(sentText[0].config.chatId, 1234567890);
  assert.deepEqual(sentText[0].env, {});
  assert.equal(JSON.stringify(client.sent).includes('support-token'), false);
});

test('relay session streams agent consult deltas token by token', async () => {
  const runtime = createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
  });
  const launch = runtime.createCall({});
  runtime.answerCall({ callId: launch.callId, token: launch.token });
  const gateway = new FakeGatewayClient();
  const client = new FakeSocket();
  const session = createTelegramCallRelaySession({
    runtime,
    gatewayClientFactory: () => gateway,
  });
  await session.start(client, {
    callId: launch.callId,
    token: launch.token,
  });

  gateway.emitEvent({
    event: 'talk.event',
    payload: {
      relaySessionId: 'relay-1',
      type: 'toolCall',
      callId: 'tool-token-1',
      name: 'openclaw_agent_consult',
      args: { question: 'hello' },
    },
  });
  await waitFor(() => gateway.requests.some((request) => request.method === 'talk.client.toolCall'));

  gateway.emitEvent({
    event: 'chat',
    payload: {
      runId: 'run-1',
      state: 'delta',
      message: { text: '我' },
    },
  });
  await waitFor(() => gateway.requests.some((request) => request.params?.result?.streamSpeech === true));

  gateway.emitEvent({
    event: 'chat',
    payload: {
      runId: 'run-1',
      state: 'delta',
      message: { text: '我在' },
    },
  });
  await waitFor(() => gateway.requests.filter((request) => request.params?.result?.streamSpeech === true).length >= 2);

  const speechSubmits = gateway.requests.filter((request) => request.params?.result?.streamSpeech === true);
  assert.deepEqual(speechSubmits.slice(0, 2).map((request) => request.params.result.text), ['我', '在']);
  assert.deepEqual(speechSubmits.slice(0, 2).map((request) => request.params.options), [
    { willContinue: true },
    { willContinue: true },
  ]);
});

test('relay session rejects invalid call tokens before connecting Gateway', async () => {
  const runtime = createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    now: () => 1000,
  });
  const gateway = new FakeGatewayClient();
  const client = new FakeSocket();
  const session = createTelegramCallRelaySession({
    runtime,
    gatewayClientFactory: () => gateway,
  });

  await session.start(client, {
    callId: 'call_missing',
    token: 'ctc_bad',
  });

  assert.equal(gateway.connectCount, 0);
  assert.deepEqual(client.sent.at(-1), {
    protocol: 'openclaw.telegram-call.relay.v1',
    type: 'error',
    code: 'call_not_found',
    message: 'Call not found',
  });
  assert.equal(client.closed, true);
});

test('relay session closes call state when Gateway startup fails', async () => {
  const runtime = createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
  });
  const launch = runtime.createCall({});
  runtime.answerCall({ callId: launch.callId, token: launch.token });
  const gateway = new FailingGatewayClient();
  const client = new FakeSocket();
  const session = createTelegramCallRelaySession({
    runtime,
    gatewayClientFactory: () => gateway,
  });

  await assert.rejects(
    session.start(client, {
      callId: launch.callId,
      token: launch.token,
    }),
    /Gateway unavailable/,
  );

  assert.equal(gateway.closed, true);
  const retry = runtime.openRelayCall({
    callId: launch.callId,
    token: launch.token,
  });
  assert.equal(retry.ok, false);
  assert.equal(retry.code, 'call_ended');
});

class FakeGatewayClient extends EventEmitter {
  constructor() {
    super();
    this.connectCount = 0;
    this.requests = [];
    this.closed = false;
  }

  async connect() {
    this.connectCount += 1;
    return { auth: { scopes: ['operator.write'] } };
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'talk.session.create') {
      return {
        relaySessionId: 'relay-1',
        sessionId: 'relay-1',
        audio: {
          inputEncoding: 'pcm16',
          inputSampleRateHz: 24000,
          outputEncoding: 'pcm16',
          outputSampleRateHz: 24000,
        },
      };
    }
    if (method === 'talk.client.toolCall') {
      return { runId: 'run-1' };
    }
    if (method === 'talk.session.steer') {
      return { ok: true, mode: 'status', message: 'working' };
    }
    return {};
  }

  addEventListener(listener) {
    this.on('event', listener);
    return () => this.off('event', listener);
  }

  emitEvent(frame) {
    this.emit('event', frame);
  }

  close() {
    this.closed = true;
  }
}

class FailingGatewayClient extends EventEmitter {
  constructor() {
    super();
    this.closed = false;
  }

  async connect() {
    throw new Error('Gateway unavailable');
  }

  addEventListener() {
    return () => undefined;
  }

  close() {
    this.closed = true;
  }
}

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.sent = [];
    this.closed = false;
    this.readyState = 1;
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  addEventListener(event, listener) {
    this.on(event, (payload) => listener({ data: payload }));
  }

  close() {
    this.closed = true;
    this.readyState = 3;
  }

  emitJson(value) {
    this.emit('message', JSON.stringify(value));
  }
}

class FakeGatewayWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = FakeGatewayWebSocket.CONNECTING;
    this.sent = [];
    FakeGatewayWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeGatewayWebSocket.OPEN;
      this.emit('open');
    });
  }

  send(raw) {
    this.sent.push(JSON.parse(raw));
  }

  addEventListener(event, listener) {
    this.on(event, (payload) => listener({ data: payload }));
  }

  close(code = 1000, reason = '') {
    this.readyState = FakeGatewayWebSocket.CLOSED;
    this.emit('close', code, reason);
  }

  serverMessage(frame) {
    this.emit('message', JSON.stringify(frame));
  }
}

async function waitFor(predicate) {
  const started = Date.now();
  while (Date.now() - started < 1000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition timed out');
}

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createIncrementingClock(startMs, stepMs) {
  let current = startMs - stepMs;
  return () => {
    current += stepMs;
    return current;
  };
}
