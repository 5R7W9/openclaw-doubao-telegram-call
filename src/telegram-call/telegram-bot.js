import {
  compactObject,
  readBoolean,
  readChatId,
  readString,
} from '../values.js';

const DEFAULT_BOT_API_BASE_URL = 'https://api.telegram.org';
const DEFAULT_BUTTON_TEXT = '接听';

export function normalizeTelegramBotConfig(config = {}, env = process.env) {
  const disableNotification = readBoolean(config.disableNotification)
    ?? readBoolean(config.telegramDisableNotification)
    ?? readBoolean(env.TELEGRAM_CALL_DISABLE_NOTIFICATION)
    ?? false;

  return compactObject({
    accountId: readString(config.accountId)
      ?? readString(config.telegramAccountId),
    botToken: readString(config.botToken)
      ?? readString(config.telegramBotToken)
      ?? readString(env.TELEGRAM_BOT_TOKEN),
    chatId: readChatId(config.chatId)
      ?? readChatId(config.telegramChatId)
      ?? readChatId(config.defaultTo)
      ?? readChatId(config.telegramDefaultTo)
      ?? readChatId(env.TELEGRAM_CALL_CHAT_ID),
    buttonText: readString(config.buttonText)
      ?? readString(config.telegramButtonText)
      ?? readString(env.TELEGRAM_CALL_BUTTON_TEXT)
      ?? DEFAULT_BUTTON_TEXT,
    messageText: readString(config.messageText)
      ?? readString(config.telegramMessageText)
      ?? readString(env.TELEGRAM_CALL_MESSAGE_TEXT),
    disableNotification,
    apiBaseUrl: readString(config.apiBaseUrl)
      ?? readString(config.telegramBotApiBaseUrl)
      ?? readString(env.TELEGRAM_BOT_API_BASE_URL),
  });
}

export function buildTelegramCallInvitePayload(options = {}) {
  const chatId = readChatId(options.chatId);
  const url = readString(options.launch?.url);
  if (chatId === undefined) {
    throw configurationError('telegram_chat_not_configured', 'Telegram chat id is not configured');
  }
  if (!url) {
    throw configurationError('telegram_call_url_missing', 'Telegram Mini App URL is missing');
  }

  const label = readString(options.launch?.profile?.label)
    ?? readString(options.profile?.label)
    ?? 'OpenClaw';
  const messageText = formatMessageText(options.messageText, { label });

  return {
    chat_id: chatId,
    text: messageText,
    disable_notification: Boolean(options.disableNotification),
    reply_markup: {
      inline_keyboard: [[{
        text: readString(options.buttonText) ?? DEFAULT_BUTTON_TEXT,
        web_app: { url },
      }]],
    },
  };
}

export async function sendTelegramCallLaunch(options = {}) {
  const config = normalizeTelegramBotConfig(options.config, options.env ?? process.env);
  if (!config.botToken) {
    throw configurationError('telegram_bot_not_configured', 'Telegram bot token is not configured');
  }

  const payload = buildTelegramCallInvitePayload({
    chatId: config.chatId,
    launch: options.launch,
    buttonText: config.buttonText,
    messageText: config.messageText,
    disableNotification: config.disableNotification,
  });

  return sendTelegramCallInvite({
    botToken: config.botToken,
    payload,
    fetchImpl: options.fetchImpl,
    apiBaseUrl: config.apiBaseUrl,
  });
}

export async function sendTelegramTextMessage(options = {}) {
  const config = normalizeTelegramBotConfig(options.config, options.env ?? process.env);
  const text = readString(options.text);
  if (!config.botToken) {
    throw configurationError('telegram_bot_not_configured', 'Telegram bot token is not configured');
  }
  if (config.chatId === undefined) {
    throw configurationError('telegram_chat_not_configured', 'Telegram chat id is not configured');
  }
  if (!text) {
    throw configurationError('telegram_text_missing', 'Telegram text is missing');
  }

  return sendTelegramCallInvite({
    botToken: config.botToken,
    payload: {
      chat_id: config.chatId,
      text,
      disable_notification: Boolean(config.disableNotification),
    },
    fetchImpl: options.fetchImpl,
    apiBaseUrl: config.apiBaseUrl,
  });
}

export async function sendTelegramCallInvite(options = {}) {
  const botToken = readString(options.botToken);
  if (!botToken) {
    throw configurationError('telegram_bot_not_configured', 'Telegram bot token is not configured');
  }
  if (!options.payload) {
    throw configurationError('telegram_payload_missing', 'Telegram payload is missing');
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw configurationError('telegram_fetch_unavailable', 'Fetch is unavailable for Telegram Bot API');
  }

  const baseUrl = normalizeBotApiBaseUrl(options.apiBaseUrl);
  const response = await fetchImpl(`${baseUrl}/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(options.payload),
  });
  const data = await readTelegramJson(response);
  if (!response.ok || data?.ok !== true) {
    const description = readString(data?.description) ?? `HTTP ${response.status}`;
    const error = new Error(`Telegram sendMessage failed with status ${response.status}: ${description}`);
    error.code = 'telegram_send_failed';
    error.status = response.status;
    throw error;
  }

  return compactObject({
    messageId: data.result?.message_id,
    chatId: data.result?.chat?.id,
  });
}

function formatMessageText(template, values) {
  if (template) {
    return template.replaceAll('{label}', values.label);
  }
  return [
    `来自 ${values.label} 的语音来电`,
    '点击「接听」打开 Telegram Mini App。',
  ].join('\n');
}

async function readTelegramJson(response) {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function normalizeBotApiBaseUrl(apiBaseUrl) {
  const value = readString(apiBaseUrl) ?? DEFAULT_BOT_API_BASE_URL;
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function configurationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
