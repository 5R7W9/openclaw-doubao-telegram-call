import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTelegramCallInvitePayload,
  normalizeTelegramBotConfig,
  sendTelegramCallInvite,
  sendTelegramTextMessage,
} from '../../src/telegram-call/telegram-bot.js';

test('builds a Telegram Mini App call-card payload with web_app button', () => {
  const payload = buildTelegramCallInvitePayload({
    chatId: '12345',
    launch: {
      url: 'https://openclaw-phone.tail0000.ts.net/plugins/doubao-telegram-call/telegram-call/?callId=call_1&token=ctc_opaque&profile=main',
      profile: {
        label: 'Primary Agent',
      },
      expiresAt: 1_782_300_000,
    },
  });

  assert.equal(payload.chat_id, '12345');
  assert.match(payload.text, /来自 Primary Agent 的语音来电/);
  assert.equal(payload.disable_notification, false);
  assert.deepEqual(payload.reply_markup.inline_keyboard, [[{
    text: '接听',
    web_app: {
      url: 'https://openclaw-phone.tail0000.ts.net/plugins/doubao-telegram-call/telegram-call/?callId=call_1&token=ctc_opaque&profile=main',
    },
  }]]);
});

test('normalizes Telegram bot config from plugin config and environment', () => {
  const config = normalizeTelegramBotConfig({
    telegramButtonText: 'Pick up',
    telegramDisableNotification: true,
  }, {
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CALL_CHAT_ID: '67890',
  });

  assert.deepEqual(config, {
    botToken: 'bot-token',
    chatId: '67890',
    buttonText: 'Pick up',
    disableNotification: true,
  });
});

test('sends call-card payload through Telegram Bot API without leaking token in errors', async () => {
  const requests = [];
  const result = await sendTelegramCallInvite({
    botToken: '123456:secret-bot-token',
    payload: {
      chat_id: '12345',
      text: 'Incoming OpenClaw call from Primary Agent',
      reply_markup: {
        inline_keyboard: [[{
          text: 'Answer',
          web_app: { url: 'https://example.test/call' },
        }]],
      },
    },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 7, chat: { id: 12345 } } }),
      };
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.telegram.org/bot123456:secret-bot-token/sendMessage');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(requests[0].init.body).reply_markup.inline_keyboard[0][0].web_app.url, 'https://example.test/call');
  assert.deepEqual(result, { messageId: 7, chatId: 12345 });

  await assert.rejects(
    () => sendTelegramCallInvite({
      botToken: '123456:secret-bot-token',
      payload: { chat_id: '12345', text: 'Incoming' },
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        json: async () => ({ ok: false, description: 'Unauthorized' }),
      }),
    }),
    (error) => {
      assert.equal(error.code, 'telegram_send_failed');
      assert.equal(String(error.message).includes('secret-bot-token'), false);
      return true;
    },
  );
});

test('sends plain mirrored reply text through Telegram Bot API', async () => {
  const requests = [];
  const result = await sendTelegramTextMessage({
    config: {
      botToken: '123456:secret-bot-token',
      chatId: 1234567890,
      accountId: 'support',
    },
    text: '蘑菇回复。',
    env: {},
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: { message_id: 8, chat: { id: 1234567890 } } }),
      };
    },
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.telegram.org/bot123456:secret-bot-token/sendMessage');
  const payload = JSON.parse(requests[0].init.body);
  assert.deepEqual(payload, {
    chat_id: 1234567890,
    text: '蘑菇回复。',
    disable_notification: false,
  });
  assert.deepEqual(result, { messageId: 8, chatId: 1234567890 });
});
