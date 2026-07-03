import { normalizeTelegramBotConfig } from './telegram-bot.js';
import {
  compactRecord,
  isRecord,
  readBoolean,
  readChatId,
  readString,
} from '../values.js';

export function resolveTelegramDeliveryConfig({
  body = {},
  profile = {},
  rootConfig = {},
  runtimeConfig = {},
  env: sourceEnv = process.env,
} = {}) {
  const bodyAccountId = readString(body.telegramAccountId ?? body.accountId);
  const profileAccountId = readString(profile.telegramAccountId ?? profile.replyAccountId);
  const runtimeAccountId = readString(runtimeConfig.telegramAccountId ?? runtimeConfig.replyAccountId);
  const requestedAccountId = bodyAccountId ?? profileAccountId ?? runtimeAccountId;
  const accountConfig = resolveOpenClawTelegramAccountConfig(rootConfig, requestedAccountId);
  const accountId = requestedAccountId ?? accountConfig.accountId;
  const allowEnvFallback = !accountId || accountId === 'default';
  const env = allowEnvFallback ? sourceEnv : {};
  const runtimeBotToken = allowEnvFallback
    ? readString(runtimeConfig.telegramBotToken ?? runtimeConfig.botToken)
    : undefined;

  const config = normalizeTelegramBotConfig({
    accountId,
    botToken: readString(body.telegramBotToken ?? body.botToken)
      ?? readString(profile.telegramBotToken ?? profile.botToken)
      ?? accountConfig.botToken
      ?? runtimeBotToken,
    chatId: readChatId(body.telegramChatId ?? body.chatId)
      ?? readChatId(profile.telegramChatId ?? profile.chatId)
      ?? accountConfig.chatId
      ?? readChatId(runtimeConfig.telegramChatId ?? runtimeConfig.chatId),
    buttonText: readString(body.telegramButtonText ?? body.buttonText)
      ?? readString(profile.telegramButtonText ?? profile.buttonText)
      ?? readString(runtimeConfig.telegramButtonText ?? runtimeConfig.buttonText),
    messageText: readString(body.telegramMessageText ?? body.messageText)
      ?? readString(profile.telegramMessageText ?? profile.messageText)
      ?? readString(runtimeConfig.telegramMessageText ?? runtimeConfig.messageText),
    disableNotification: readBoolean(body.telegramDisableNotification ?? body.disableNotification)
      ?? readBoolean(profile.telegramDisableNotification ?? profile.disableNotification)
      ?? readBoolean(runtimeConfig.telegramDisableNotification ?? runtimeConfig.disableNotification),
    apiBaseUrl: readString(body.telegramBotApiBaseUrl ?? body.apiBaseUrl)
      ?? readString(profile.telegramBotApiBaseUrl ?? profile.apiBaseUrl)
      ?? accountConfig.apiBaseUrl
      ?? readString(runtimeConfig.telegramBotApiBaseUrl ?? runtimeConfig.apiBaseUrl),
  }, env);

  return { config, env };
}

export function resolveOpenClawTelegramAccountConfig(rootConfig, accountId) {
  const telegram = rootConfig?.channels?.telegram;
  if (!isRecord(telegram)) {
    return {};
  }

  const requestedAccountId = readString(accountId)
    ?? readString(telegram.defaultAccount)
    ?? (resolveTelegramAccount(telegram.accounts, 'default') ? 'default' : undefined);
  const account = resolveTelegramAccount(telegram.accounts, requestedAccountId);
  const source = isRecord(account) ? account : (requestedAccountId === 'default' ? telegram : undefined);
  if (!isRecord(source)) {
    return compactRecord({ accountId: requestedAccountId }) ?? {};
  }

  return compactRecord({
    accountId: requestedAccountId,
    botToken: readString(source.botToken)
      ?? readString(source.token)
      ?? readString(source.accessToken),
    chatId: readChatId(source.defaultTo)
      ?? readChatId(source.chatId)
      ?? readChatId(source.telegramChatId),
    apiBaseUrl: readString(source.apiBaseUrl)
      ?? readString(source.telegramBotApiBaseUrl)
      ?? readString(telegram.apiBaseUrl)
      ?? readString(telegram.telegramBotApiBaseUrl),
  }) ?? {};
}

function resolveTelegramAccount(accounts, accountId) {
  const requestedAccountId = readString(accountId);
  if (!requestedAccountId) {
    return undefined;
  }
  if (isRecord(accounts)) {
    if (isRecord(accounts[requestedAccountId])) {
      return accounts[requestedAccountId];
    }
    const normalized = requestedAccountId.toLowerCase();
    const match = Object.entries(accounts).find(([id]) => id.toLowerCase() === normalized);
    return isRecord(match?.[1]) ? match[1] : undefined;
  }
  if (Array.isArray(accounts)) {
    return accounts.find((account) => {
      if (!isRecord(account)) {
        return false;
      }
      const id = readString(account.id) ?? readString(account.accountId) ?? readString(account.name);
      return id?.toLowerCase() === requestedAccountId.toLowerCase();
    });
  }
  return undefined;
}
