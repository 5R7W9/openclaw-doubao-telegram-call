import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REALTIME_PROVIDER_ID,
} from '../../src/telegram-call/constants.js';
import {
  createTelegramCallRuntime,
} from '../../src/telegram-call/runtime.js';
import {
  registerTelegramCallTools,
} from '../../src/telegram-call/tools.js';

const TOOL_NAMES = [
  'create_telegram_call_link',
  'send_telegram_call_card',
  'list_telegram_call_profiles',
];

test('registerTelegramCallTools registers native OpenClaw call tools', () => {
  const runtime = createRuntime();
  const tools = [];

  const registered = requireRegisterTelegramCallTools()({
    registerTool(tool, options) {
      tools.push({ tool, options });
    },
  }, { runtime });

  assert.equal(registered, true);
  assert.deepEqual(tools.map(({ tool }) => tool.name), TOOL_NAMES);
  for (const { tool } of tools) {
    assert.equal(typeof tool.description, 'string');
    assert.equal(tool.parameters.type, 'object');
    assert.equal(typeof tool.execute, 'function');
  }
});

test('create_telegram_call_link uses the shared runtime so the HTTP routes can answer the call', async () => {
  const runtime = createRuntime({
    publicBaseUrl: 'https://calls.example.test',
    callProfiles: {
      main: {
        label: 'Primary Agent',
        agentId: 'main',
        sessionKey: 'main',
        providerId: REALTIME_PROVIDER_ID,
        speaker: 'S_xO2upxt52',
      },
    },
  });
  const tools = collectTools({ runtime });
  const result = await executeJson(findTool(tools, 'create_telegram_call_link'), {
    profileId: 'main',
    chatId: 'telegram:1234567890',
    userId: 'telegram-user',
  });

  assert.equal(result.ok, true);
  assert.equal(result.profile.id, 'main');
  assert.match(result.url, /^https:\/\/calls\.example\.test\/plugins\/doubao-telegram-call\/telegram-call\/\?/);

  const url = new URL(result.url);
  const answer = runtime.answerCall({
    callId: url.searchParams.get('callId'),
    token: url.searchParams.get('token'),
    profileId: 'main',
  });

  assert.equal(result.callId, url.searchParams.get('callId'));
  assert.equal(answer.ok, true);
  assert.equal(answer.payload.call.profileId, 'main');
});

test('send_telegram_call_card resolves Telegram account config and does not leak bot tokens', async () => {
  const runtime = createRuntime({
    publicBaseUrl: 'https://calls.example.test',
    callProfiles: {
      support: {
        label: 'Support Agent',
        agentId: 'support',
        sessionKey: 'agent:support:main',
        providerId: REALTIME_PROVIDER_ID,
        telegramAccountId: 'support',
      },
    },
  });
  const sent = [];
  const tools = collectTools({
    api: {
      config: {
        channels: {
          telegram: {
            accounts: {
              support: {
                botToken: 'support-token',
                defaultTo: 1234567890,
              },
            },
          },
        },
      },
    },
    runtime,
    telegramSender: async (params) => {
      sent.push(params);
      return { messageId: 42, chatId: params.config.chatId };
    },
  });

  const result = await executeJson(findTool(tools, 'send_telegram_call_card'), {
    profileId: 'support',
  });

  assert.equal(result.ok, true);
  assert.equal(result.telegram.messageId, 42);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].config.accountId, 'support');
  assert.equal(sent[0].config.botToken, 'support-token');
  assert.equal(sent[0].config.chatId, 1234567890);
  assert.match(sent[0].launch.url, /^https:\/\/calls\.example\.test\/plugins\/doubao-telegram-call\/telegram-call\/\?/);
  assert.equal(JSON.stringify(result).includes('support-token'), false);
  assert.equal(JSON.stringify(result).includes('ctc_'), false);

  const url = new URL(sent[0].launch.url);
  const answer = runtime.answerCall({
    callId: url.searchParams.get('callId'),
    token: url.searchParams.get('token'),
    profileId: 'support',
  });
  assert.equal(answer.ok, true);
});

test('list_telegram_call_profiles returns profile summaries without Telegram secrets', async () => {
  const runtime = createRuntime({
    defaultProfile: 'main',
    callProfiles: {
      main: {
        label: 'Primary Agent',
        agentId: 'main',
        providerId: REALTIME_PROVIDER_ID,
        telegramBotToken: 'secret-token',
      },
      secondary: {
        label: 'Secondary Agent',
        agentId: 'secondary-agent',
        sessionKey: 'agent:secondary-agent:main',
        speaker: 'S_secondary',
      },
    },
  });
  const tools = collectTools({ runtime });

  const result = await executeJson(findTool(tools, 'list_telegram_call_profiles'), {});

  assert.equal(result.ok, true);
  assert.equal(result.defaultProfile, 'main');
  assert.deepEqual(result.profiles.map((profile) => profile.id), ['main', 'secondary']);
  assert.equal(JSON.stringify(result).includes('secret-token'), false);
});

function requireRegisterTelegramCallTools() {
  assert.equal(typeof registerTelegramCallTools, 'function');
  return registerTelegramCallTools;
}

function collectTools({ api = {}, runtime, telegramSender } = {}) {
  const tools = [];
  requireRegisterTelegramCallTools()({
    ...api,
    registerTool(tool, options) {
      tools.push({ tool, options });
    },
  }, { runtime, telegramSender });
  return tools;
}

function findTool(tools, name) {
  const registration = tools.find(({ tool }) => tool.name === name);
  assert.ok(registration, `missing tool ${name}`);
  return registration.tool;
}

async function executeJson(tool, params) {
  const result = await tool.execute('unit-test-tool-call', params);
  const text = result?.content?.find((entry) => entry?.type === 'text')?.text;
  assert.equal(typeof text, 'string');
  return JSON.parse(text);
}

function createRuntime(config = {}) {
  return createTelegramCallRuntime({
    tokenSecret: 'unit-test-secret',
    randomBytes: (size) => Buffer.alloc(size, 7),
    now: () => 1000,
    config,
  });
}
