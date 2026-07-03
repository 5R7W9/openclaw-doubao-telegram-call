import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ROUTE_PREFIX,
} from '../../src/telegram-call/constants.js';
import {
  createTelegramCallRuntime,
  normalizeCallProfiles,
} from '../../src/telegram-call/runtime.js';

test('normalizes configurable call profiles without hard-coding one agent', () => {
  const profiles = normalizeCallProfiles({
    defaultProfile: 'primary',
    callProfiles: {
      primary: {
        label: 'Primary Agent',
        agentId: 'main',
        speaker: 'S_nox',
        model: '1.2.1.1',
        telegramAccountId: 'default',
        avatarUrl: '/plugins/doubao-telegram-call/telegram-call/assets/avatars/primary.png',
        avatarText: 'PA',
        instructions: 'Keep it brief.',
      },
      secondary: {
        label: 'Secondary Agent',
        agentId: 'secondary-agent',
        speaker: 'S_secondary',
        replyAccountId: 'secondary-agent',
        telegramBotToken: 'do-not-expose-this-token',
      },
    },
  });

  assert.equal(profiles.defaultProfileId, 'primary');
  assert.equal(profiles.profiles.primary.sessionKey, 'agent:main:main');
  assert.equal(profiles.profiles.secondary.sessionKey, 'agent:secondary-agent:main');
  assert.equal(profiles.profiles.secondary.sessionId, 'main');
  assert.equal(profiles.profiles.secondary.providerId, 'doubao-realtime');
  assert.equal(profiles.profiles.primary.telegramAccountId, 'default');
  assert.equal(profiles.profiles.secondary.telegramAccountId, 'secondary-agent');
  assert.equal(profiles.profiles.secondary.telegramBotToken, 'do-not-expose-this-token');
  assert.equal(profiles.profiles.primary.avatarUrl, '/plugins/doubao-telegram-call/telegram-call/assets/avatars/primary.png');
  assert.equal(profiles.profiles.primary.avatarText, 'PA');
});

test('does not expose Telegram bot tokens in public call profile payloads', () => {
  const runtime = createTelegramCallRuntime({
    config: {
      callProfiles: {
        support: {
          label: 'Support Agent',
          agentId: 'support',
          telegramAccountId: 'support',
          telegramBotToken: 'secret-support-token',
        },
      },
    },
    tokenSecret: 'unit-test-secret',
  });

  const launch = runtime.createCall({ profileId: 'support' });

  assert.equal(launch.profile.id, 'support');
  assert.equal(launch.profile.telegramAccountId, 'support');
  assert.equal('telegramBotToken' in launch.profile, false);
  assert.equal(JSON.stringify(launch).includes('secret-support-token'), false);
});

test('respects explicit session keys while defaulting to the agent main session', () => {
  const profiles = normalizeCallProfiles({
    callProfiles: {
      main: {
        agentId: 'main',
      },
      separate: {
        agentId: 'main',
        sessionId: 'separate-call',
        sessionKey: 'agent:main:separate-call',
      },
    },
  });

  assert.equal(profiles.profiles.main.sessionKey, 'agent:main:main');
  assert.equal(profiles.profiles.main.sessionId, 'main');
  assert.equal(profiles.profiles.separate.sessionKey, 'agent:main:separate-call');
});

test('infers O2 realtime model for public uranus BigTTS profile voices', () => {
  const profiles = normalizeCallProfiles({
    callProfiles: {
      support: {
        agentId: 'support',
        speaker: 'zh_male_lanyinmianbao_uranus_bigtts',
      },
      primary: {
        agentId: 'main',
        speaker: 'S_xO2upxt52',
      },
    },
  });

  assert.equal(profiles.profiles.support.model, '1.2.1.1');
  assert.equal(profiles.profiles.primary.model, undefined);
});

test('issues short-lived single-use call tokens and returns Gateway relay bootstrap', () => {
  let now = 1000;
  const runtime = createTelegramCallRuntime({
    config: {
      defaultProfile: 'primary',
      callProfiles: {
        primary: {
          label: 'Primary Agent',
          agentId: 'main',
          speaker: 'S_nox',
          model: '1.2.1.1',
          avatarUrl: './assets/avatars/primary.png',
          avatarText: 'PA',
          instructions: 'Warm and brief.',
          maxDurationSeconds: 600,
        },
      },
    },
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('0123456789abcdef0123456789abcdef', 'utf8'),
    now: () => now,
  });

  const launch = runtime.createCall({
    profileId: 'primary',
    chatId: 'telegram:chat-1',
    userId: 'telegram:user-1',
    baseUrl: 'https://gateway.example',
  });

  assert.equal(launch.profile.id, 'primary');
  assert.equal(launch.url, `https://gateway.example${ROUTE_PREFIX}/?callId=${encodeURIComponent(launch.callId)}&token=${encodeURIComponent(launch.token)}&profile=primary`);
  assert.equal(launch.token.includes('unit-test-secret'), false);

  const answer = runtime.answerCall({
    callId: launch.callId,
    token: launch.token,
    profileId: 'primary',
  });

  assert.equal(answer.ok, true);
  assert.equal(answer.payload.call.profileId, 'primary');
  assert.equal(answer.payload.call.avatarUrl, './assets/avatars/primary.png');
  assert.equal(answer.payload.call.avatarText, 'PA');
  assert.equal(answer.payload.call.instructions, 'Warm and brief.');
  assert.equal(answer.payload.gatewayRelay.provider, 'doubao-realtime');
  assert.deepEqual(answer.payload.gatewayRelay.create, {
    method: 'talk.session.create',
    params: {
      mode: 'realtime',
      transport: 'gateway-relay',
      brain: 'agent-consult',
      provider: 'doubao-realtime',
      sessionKey: 'agent:main:main',
      model: '1.2.1.1',
      voice: 'S_nox',
    },
  });
  assert.equal(answer.payload.gatewayRelay.audio.inputFrameMs, 20);
  assert.equal(answer.payload.gatewayRelay.methods.appendAudio, 'talk.session.appendAudio');
  assert.deepEqual(answer.payload.pluginRelay, {
    url: '/plugins/doubao-telegram-call/telegram-call/relay',
    protocol: 'openclaw.telegram-call.relay.v1',
    methods: {
      audio: 'audio',
      cancelOutput: 'cancelOutput',
      hangup: 'hangup',
    },
    audio: answer.payload.gatewayRelay.audio,
  });

  const reused = runtime.answerCall({
    callId: launch.callId,
    token: launch.token,
    profileId: 'primary',
  });
  assert.equal(reused.ok, false);
  assert.equal(reused.code, 'call_already_answered');

  const stillAnswerable = runtime.createCall({ profileId: 'primary' });
  now += 31_000;
  const stillAnswerableAnswer = runtime.answerCall({
    callId: stillAnswerable.callId,
    token: stillAnswerable.token,
    profileId: 'primary',
  });
  assert.equal(stillAnswerableAnswer.ok, true);

  const expired = runtime.createCall({ profileId: 'primary' });
  now += 181_000;
  const expiredAnswer = runtime.answerCall({
    callId: expired.callId,
    token: expired.token,
    profileId: 'primary',
  });
  assert.equal(expiredAnswer.ok, false);
  assert.equal(expiredAnswer.code, 'call_expired');
});

test('hangup is idempotent for pending and answered calls', () => {
  const runtime = createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    now: () => 2000,
  });
  const launch = runtime.createCall({});

  const first = runtime.hangupCall({ callId: launch.callId, token: launch.token });
  const second = runtime.hangupCall({ callId: launch.callId, token: launch.token });

  assert.equal(first.ok, true);
  assert.equal(first.payload.state, 'ended');
  assert.equal(second.ok, true);
  assert.equal(second.payload.state, 'ended');
});
