import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import {
  ROUTE_PREFIX,
} from '../../src/telegram-call/constants.js';
import {
  resolveTelegramCallConfig,
} from '../../src/telegram-call/config-file.js';
import {
  createTelegramCallRuntime,
} from '../../src/telegram-call/runtime.js';
import {
  registerTelegramCallRoutes,
  resolvePluginConfig,
} from '../../src/telegram-call/routes.js';

test('answer route validates token and writes Gateway relay bootstrap JSON', async () => {
  const runtime = createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
  });
  const launch = runtime.createCall({});
  const routes = [];

  registerTelegramCallRoutes({
    registerHttpRoute(route) {
      routes.push(route);
    },
  }, { runtime });

  const answerRoute = routes.find((route) => route.path === `${ROUTE_PREFIX}/answer`);
  assert.ok(answerRoute);

  const res = createResponse();
  const handled = await answerRoute.handler(createJsonRequest('POST', {
    callId: launch.callId,
    token: launch.token,
  }), res);

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.gatewayRelay.create.method, 'talk.session.create');
  assert.equal(res.body.gatewayRelay.audio.inputSampleRateHz, 24000);
  assert.equal(res.body.pluginRelay.url, `${ROUTE_PREFIX}/relay`);
  assert.equal(res.body.pluginRelay.protocol, 'openclaw.telegram-call.relay.v1');
  assert.equal(res.body.pluginRelay.methods.audio, 'audio');
});

test('launch route is gateway-authenticated and creates a Mini App call URL', async () => {
  const runtime = createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
  });
  const routes = [];

  registerTelegramCallRoutes({
    registerHttpRoute(route) {
      routes.push(route);
    },
  }, { runtime });

  const launchRoute = routes.find((route) => route.path === `${ROUTE_PREFIX}/launch`);
  assert.ok(launchRoute);
  assert.equal(launchRoute.auth, 'gateway');

  const res = createResponse();
  await launchRoute.handler(createJsonRequest('POST', {
    profileId: 'default',
    chatId: 'telegram:chat-1',
  }, '/', {
    host: '127.0.0.1:41621',
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.match(res.body.callId, /^call_/);
  assert.match(res.body.token, /^ctc_/);
  assert.match(res.body.url, /^http:\/\/127\.0\.0\.1:41621\/plugins\/doubao-telegram-call\/telegram-call\/\?/);
  assert.equal(res.body.profile.id, 'default');
});

test('launch send route is gateway-authenticated and sends Telegram Mini App call card', async () => {
  const runtime = createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
    config: {
      publicBaseUrl: 'https://openclaw-phone.tail0000.ts.net',
      telegramChatId: '12345',
    },
  });
  const sent = [];
  const routes = [];

  registerTelegramCallRoutes({
    registerHttpRoute(route) {
      routes.push(route);
    },
  }, {
    runtime,
    telegramSender: async (params) => {
      sent.push(params);
      return { messageId: 9, chatId: '12345' };
    },
  });

  const launchSendRoute = routes.find((route) => route.path === `${ROUTE_PREFIX}/launch/send`);
  assert.ok(launchSendRoute);
  assert.equal(launchSendRoute.auth, 'gateway');

  const res = createResponse();
  await launchSendRoute.handler(createJsonRequest('POST', {
    profileId: 'default',
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.telegram.messageId, 9);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].config.chatId, '12345');
  assert.match(sent[0].launch.url, /^https:\/\/openclaw-phone\.tail0000\.ts\.net\/plugins\/doubao-telegram-call\/telegram-call\/\?/);
  assert.equal(sent[0].launch.profile.id, 'default');
});

test('launch send route resolves per-profile Telegram account tokens from OpenClaw config', async () => {
  const runtime = createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    randomBytes: () => Buffer.from('abcdefabcdefabcdefabcdefabcdef12', 'utf8'),
    now: () => 1000,
    config: {
      publicBaseUrl: 'https://openclaw-phone.tail0000.ts.net',
      callProfiles: {
        main: {
          label: 'Primary Agent',
          agentId: 'main',
          telegramAccountId: 'default',
        },
        support: {
          label: 'Support Agent',
          agentId: 'support',
          sessionKey: 'agent:support:main',
          speaker: 'zh_male_lanyinmianbao_uranus_bigtts',
          telegramAccountId: 'support',
        },
      },
    },
  });
  const sent = [];
  const routes = [];

  registerTelegramCallRoutes({
    config: {
      channels: {
        telegram: {
          defaultAccount: 'default',
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
    registerHttpRoute(route) {
      routes.push(route);
    },
  }, {
    runtime,
    telegramSender: async (params) => {
      sent.push(params);
      return { messageId: 12, chatId: 1234567890 };
    },
  });

  const launchSendRoute = routes.find((route) => route.path === `${ROUTE_PREFIX}/launch/send`);
  assert.ok(launchSendRoute);

  const res = createResponse();
  await launchSendRoute.handler(createJsonRequest('POST', {
    profileId: 'support',
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.profile.id, 'support');
  assert.equal(res.body.profile.telegramAccountId, 'support');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].config.accountId, 'support');
  assert.equal(sent[0].config.botToken, 'support-token');
  assert.equal(sent[0].config.chatId, 1234567890);
  assert.equal(sent[0].launch.profile.label, 'Support Agent');
  assert.deepEqual(sent[0].env, {});
});

test('plugin config can be extended from a JSON call config file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-call-config-'));
  const configFile = join(directory, 'telegram-call.config.json');
  await writeFile(configFile, JSON.stringify({
    defaultProfile: 'secondary',
    publicBaseUrl: 'https://file-public.tail0000.ts.net',
    callProfiles: {
      main: {
        label: 'Primary Agent From File',
        agentId: 'main',
        avatarText: 'FILE-PA',
        speaker: 'S_file',
      },
      secondary: {
        label: 'Secondary Agent',
        agentId: 'secondary-agent',
        avatarText: 'SECONDARY',
        speaker: 'S_secondary',
      },
    },
  }), 'utf8');

  try {
    const config = resolvePluginConfig({
      pluginConfig: {
        configFile,
        callProfiles: {
          main: {
            label: 'Primary Agent Inline',
            speaker: 'S_inline',
          },
        },
      },
    });

    assert.equal(config.defaultProfile, 'secondary');
    assert.equal(config.publicBaseUrl, 'https://file-public.tail0000.ts.net');
    assert.equal(config.callProfiles.secondary.agentId, 'secondary-agent');
    assert.equal(config.callProfiles.secondary.avatarText, 'SECONDARY');
    assert.equal(config.callProfiles.main.label, 'Primary Agent Inline');
    assert.equal(config.callProfiles.main.agentId, 'main');
    assert.equal(config.callProfiles.main.avatarText, 'FILE-PA');
    assert.equal(config.callProfiles.main.speaker, 'S_inline');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('runtime config reads public URL and Telegram delivery from environment', () => {
  const config = resolveTelegramCallConfig({}, {
    env: {
      TELEGRAM_CALL_PUBLIC_BASE_URL: 'https://public-phone.tail0000.ts.net',
      TELEGRAM_CALL_DEFAULT_PROFILE: 'main',
      TELEGRAM_CALL_PROFILES_JSON: JSON.stringify({
        main: {
          label: 'Primary Agent',
          agentId: 'main',
          sessionKey: 'agent:main:main',
          speaker: 'S_primary',
          model: '1.2.1.1',
          telegramAccountId: 'default',
        },
        support: {
          label: 'Support Agent',
          agentId: 'support',
          sessionKey: 'agent:support:main',
          speaker: 'zh_male_lanyinmianbao_uranus_bigtts',
          telegramAccountId: 'support',
        },
      }),
      TELEGRAM_CALL_TOKEN_TTL_SECONDS: '120',
      TELEGRAM_BOT_TOKEN: 'env-bot-token',
      TELEGRAM_CALL_CHAT_ID: '12345',
      TELEGRAM_CALL_BUTTON_TEXT: 'Answer',
      TELEGRAM_CALL_MESSAGE_TEXT: 'Incoming call from {label}',
      TELEGRAM_CALL_DISABLE_NOTIFICATION: 'true',
      TELEGRAM_BOT_API_BASE_URL: 'https://telegram.example.test',
      TELEGRAM_CALL_ACCOUNT_ID: 'default',
      TELEGRAM_CALL_MIRROR_REPLIES: 'true',
    },
    existsSync: () => false,
  });

  assert.deepEqual(config, {
    publicBaseUrl: 'https://public-phone.tail0000.ts.net',
    defaultProfile: 'main',
    callProfiles: {
      main: {
        label: 'Primary Agent',
        agentId: 'main',
        sessionKey: 'agent:main:main',
        speaker: 'S_primary',
        model: '1.2.1.1',
        telegramAccountId: 'default',
      },
      support: {
        label: 'Support Agent',
        agentId: 'support',
        sessionKey: 'agent:support:main',
        speaker: 'zh_male_lanyinmianbao_uranus_bigtts',
        telegramAccountId: 'support',
      },
    },
    callTokenTtlSeconds: 120,
    telegramBotToken: 'env-bot-token',
    telegramChatId: '12345',
    telegramButtonText: 'Answer',
    telegramMessageText: 'Incoming call from {label}',
    telegramDisableNotification: true,
    telegramBotApiBaseUrl: 'https://telegram.example.test',
    telegramAccountId: 'default',
    telegramMirrorReplies: true,
  });
});

test('JSON call config file can own call profile overrides when requested', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'telegram-call-config-'));
  const configFile = join(directory, 'telegram-call.config.json');
  await writeFile(configFile, JSON.stringify({
    preferFileCallProfiles: true,
    callProfiles: {
      main: {
        label: 'Primary Agent From File',
        agentId: 'main',
        speaker: 'S_xO2upxt52',
        model: '1.2.1.1',
      },
    },
  }), 'utf8');

  try {
    const config = resolvePluginConfig({
      pluginConfig: {
        configFile,
        callProfiles: {
          main: {
            label: 'Primary Agent Inline',
            speaker: 'S_xO2upxt52',
            model: '2.2.0.0',
          },
        },
      },
    });

    assert.equal(config.callProfiles.main.label, 'Primary Agent From File');
    assert.equal(config.callProfiles.main.model, '1.2.1.1');
    assert.equal(config.callProfiles.main.speaker, 'S_xO2upxt52');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('relay websocket route is plugin-authenticated and owns upgrades', async () => {
  const routes = [];
  registerTelegramCallRoutes({
    registerHttpRoute(route) {
      routes.push(route);
    },
  }, {
    runtime: createTelegramCallRuntime({ tokenSecret: 'unit-test-secret' }),
  });

  const relayRoute = routes.find((route) => route.path === `${ROUTE_PREFIX}/relay`);
  assert.ok(relayRoute);
  assert.equal(relayRoute.auth, 'plugin');
  assert.equal(relayRoute.match, 'exact');
  assert.equal(typeof relayRoute.handleUpgrade, 'function');
});

test('client log route accepts sanitized Mini App diagnostics', async () => {
  const routes = [];
  const logs = [];
  registerTelegramCallRoutes({
    registerHttpRoute(route) {
      routes.push(route);
    },
  }, {
    runtime: createTelegramCallRuntime({ tokenSecret: 'unit-test-secret' }),
    clientLogSink: (entry) => logs.push(entry),
  });

  const logRoute = routes.find((route) => route.path === `${ROUTE_PREFIX}/client-log`);
  assert.ok(logRoute);
  assert.equal(logRoute.auth, 'plugin');

  const res = createResponse();
  await logRoute.handler(createJsonRequest('POST', {
    callId: 'call_123456789',
    profileId: 'main',
    stage: 'capture_error',
    name: 'NotSupportedError',
    message: 'AudioWorklet failed',
    token: 'ctc_should_not_be_logged',
    url: 'https://example.invalid/?token=ctc_should_not_be_logged',
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0], {
    callId: 'call_123456789',
    profileId: 'main',
    stage: 'capture_error',
    name: 'NotSupportedError',
    message: 'AudioWorklet failed',
  });
});

test('static routes serve Mini App shell and assets from plugin directory', async () => {
  const routes = [];
  registerTelegramCallRoutes({
    registerHttpRoute(route) {
      routes.push(route);
    },
  }, {
    runtime: createTelegramCallRuntime({ tokenSecret: 'unit-test-secret' }),
  });

  const indexRoute = routes.find((route) => route.path === `${ROUTE_PREFIX}/`);
  const assetRoute = routes.find((route) => route.path === `${ROUTE_PREFIX}/assets/`);
  assert.ok(indexRoute);
  assert.ok(assetRoute);

  const indexRes = createResponse();
  await indexRoute.handler(createJsonRequest('GET'), indexRes);
  assert.equal(indexRes.statusCode, 200);
  assert.match(indexRes.bodyText, /telegram-call-root/);
  assert.match(indexRes.bodyText, /avatar-image/);
  assert.match(indexRes.bodyText, /avatar-fallback/);

  const assetRes = createResponse();
  await assetRoute.handler(createJsonRequest('GET', undefined, `${ROUTE_PREFIX}/assets/app.js`), assetRes);
  assert.equal(assetRes.statusCode, 200);
  assert.equal(assetRes.headers['cache-control'], 'no-store');
  assert.match(assetRes.bodyText, /DoubaoTelegramCallApp/);

  const relayRes = createResponse();
  await assetRoute.handler(createJsonRequest('GET', undefined, `${ROUTE_PREFIX}/assets/relay.js`), relayRes);
  assert.equal(relayRes.statusCode, 200);
  assert.match(relayRes.bodyText, /TelegramCallPluginRelay/);
});

test('Mini App capture keeps microphone monitoring muted locally', async () => {
  const app = await readFile(new URL('../../web/telegram-call/app.js', import.meta.url), 'utf8');

  assert.match(app, /createGain\(\)/);
  assert.match(app, /gain\.value = 0/);
  assert.doesNotMatch(app, /captureNode\.connect\(state\.audioContext\.destination\)/);
  assert.doesNotMatch(app, /openClawTelegramCallRelay\?\.appendAudio\?\.\(detail\)/);
});

test('Mini App uses WebView-safe capture fallback and does not force 24 kHz AudioContext', async () => {
  const app = await readFile(new URL('../../web/telegram-call/app.js', import.meta.url), 'utf8');
  const worklet = await readFile(new URL('../../web/telegram-call/pcm-worklet.js', import.meta.url), 'utf8');

  assert.doesNotMatch(app, /sampleRate:\s*requestedRate/);
  assert.match(app, /createScriptProcessor/);
  assert.match(app, /clientLog\(/);
  assert.match(worklet, /targetSampleRateHz/);
  assert.match(worklet, /resampleFloat32/);
});

test('Mini App preloads the PCM worklet before capture starts', async () => {
  const app = await readFile(new URL('../../web/telegram-call/app.js', import.meta.url), 'utf8');

  assert.match(app, /let workletPreloadPromise/);
  assert.match(app, /function preloadAudioWorklet\(\)/);
  assert.match(app, /fetch\(`\$\{ROUTE_PREFIX\}\/assets\/pcm-worklet\.js`/);

  const pageReadyIndex = app.indexOf("clientLog('page_ready');");
  const preloadCallIndex = app.indexOf('void preloadAudioWorklet();');
  const awaitPreloadIndex = app.indexOf('await preloadAudioWorklet();');
  const addModuleIndex = app.indexOf('await state.audioContext.audioWorklet.addModule');

  assert.ok(preloadCallIndex > pageReadyIndex);
  assert.ok(awaitPreloadIndex > 0);
  assert.ok(addModuleIndex > awaitPreloadIndex);
});

test('Mini App validates answer token before opening microphone', async () => {
  const app = await readFile(new URL('../../web/telegram-call/app.js', import.meta.url), 'utf8');

  const answerFetchIndex = app.indexOf('const payload = await requestAnswer();');
  const getUserMediaIndex = app.indexOf('navigator.mediaDevices.getUserMedia');

  assert.ok(answerFetchIndex > 0);
  assert.ok(getUserMediaIndex > 0);
  assert.ok(answerFetchIndex < getUserMediaIndex);
  assert.match(app, /function requestAnswer/);
  assert.match(app, /Call expired/);
  assert.match(app, /来电已过期，请重新发起/);
});

test('Mini App starts microphone and relay concurrently after answer is accepted', async () => {
  const app = await readFile(new URL('../../web/telegram-call/app.js', import.meta.url), 'utf8');

  const answerOkIndex = app.indexOf("clientLog('answer_ok');");
  const micPromiseIndex = app.indexOf('const micPromise = navigator.mediaDevices.getUserMedia');
  const relayStartPromiseIndex = app.indexOf('const relayStartPromise = state.relay.start()');
  const waitBothIndex = app.indexOf('await Promise.all([micPromise, relayStartPromise])');

  assert.ok(answerOkIndex > 0);
  assert.ok(micPromiseIndex > answerOkIndex);
  assert.ok(relayStartPromiseIndex > answerOkIndex);
  assert.ok(waitBothIndex > micPromiseIndex);
  assert.ok(waitBothIndex > relayStartPromiseIndex);
});

test('Mini App logs first user audio and playback latency milestones', async () => {
  const app = await readFile(new URL('../../web/telegram-call/app.js', import.meta.url), 'utf8');

  assert.match(app, /firstUserAudioLogged/);
  assert.match(app, /clientLog\('first_user_audio'/);
  assert.match(app, /firstUserSpeechAudioLogged/);
  assert.match(app, /clientLog\('first_user_speech_audio'/);
  assert.match(app, /detectSpeechFromPcm16/);
  assert.match(app, /onPlaybackStart/);
  assert.match(app, /clientLog\('playback_started'/);
  assert.match(app, /atMs/);
});

test('Mini App starts as a localized 1-bit gothic incoming call with ringtone state', async () => {
  const html = await readFile(new URL('../../web/telegram-call/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../../web/telegram-call/app.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('../../web/telegram-call/styles.css', import.meta.url), 'utf8');

  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /哥特电话/);
  assert.match(html, /拒绝/);
  assert.match(html, /接听/);
  assert.match(html, /静音/);
  assert.match(html, /status-line/);
  assert.doesNotMatch(html, /status-grid/);
  assert.doesNotMatch(html, /☎|◇|×/);
  assert.match(app, /来电/);
  assert.match(app, /接听中/);
  assert.match(app, /已静音/);
  assert.match(app, /renderAvatar/);
  assert.match(css, /--ink:\s*#fff/);
  assert.match(css, /--paper:\s*#000/);
  assert.doesNotMatch(css, /@font-face/);
  assert.match(css, /clip-path:\s*polygon/);
  assert.match(css, /grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/);
  assert.match(css, /\.controls\s*{[^}]*position:\s*sticky/s);
  assert.doesNotMatch(css, /align-content:\s*center/);
  assert.match(app, /startRingtone\(\)/);
  assert.match(app, /stopRingtone\(\)/);
  assert.match(app, /hangupButton\.disabled = false/);
  assert.match(css, /\.call-shell\[data-state="idle"\] \.avatar-frame/);
  assert.match(css, /@keyframes ringPulse/);
});

test('Mini App leaves the hangup control available after UI errors', async () => {
  const app = await readFile(new URL('../../web/telegram-call/app.js', import.meta.url), 'utf8');

  assert.match(app, /function setError\(message\)[\s\S]*hangupButton\.disabled = false/);
  assert.doesNotMatch(app, /function setError\(message\)[\s\S]*hangupButton\.disabled = true/);
});

test('Mini App does not start ringtone audio from call control taps before microphone capture', async () => {
  const app = await readFile(new URL('../../web/telegram-call/app.js', import.meta.url), 'utf8');

  assert.match(app, /await stopRingtone\(\)/);
  assert.match(app, /function unlockRingtoneAudio\(event\)/);
  assert.match(app, /isCallControlEvent\(event\)/);
  assert.match(app, /if \(!state\.ringtoneAudioUnlocked\) {\s*return;\s*}/s);
});

test('Mini App localizes Telegram iOS microphone capture failures', async () => {
  const app = await readFile(new URL('../../web/telegram-call/app.js', import.meta.url), 'utf8');

  assert.match(app, /No AVAudioSessionCaptureDevice device/);
  assert.match(app, /Telegram 无法打开麦克风/);
});

function createJsonRequest(method, body, url = '/', headers = {}) {
  const req = new PassThrough();
  req.method = method;
  req.url = url;
  req.headers = { 'content-type': 'application/json', ...headers };
  if (body !== undefined) {
    req.end(JSON.stringify(body));
  } else {
    req.end();
  }
  return req;
}

function createResponse() {
  const chunks = [];
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      this.bodyBuffer = Buffer.concat(chunks);
      this.bodyText = this.bodyBuffer.toString('utf8');
      try {
        this.body = JSON.parse(this.bodyText);
      } catch {
        this.body = undefined;
      }
    },
  };
}
