import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compactRecord,
  isRecord,
  readBoolean,
  readString,
} from '../values.js';

const DEFAULT_CONFIG_FILE = 'telegram-call.config.json';
const PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function resolveTelegramCallConfig(config = {}, options = {}) {
  const env = options.env ?? process.env;
  const inlineConfig = isRecord(config) ? config : {};
  const fileConfig = loadTelegramCallConfigFile(inlineConfig, options);
  const envConfig = readEnvTelegramCallConfig(env);
  return mergeTelegramCallConfig(mergeTelegramCallConfig(envConfig, fileConfig), inlineConfig);
}

export function loadTelegramCallConfigFile(config = {}, options = {}) {
  const env = options.env ?? process.env;
  const baseDir = options.baseDir ?? PLUGIN_ROOT;
  const existsSync = options.existsSync ?? nodeExistsSync;
  const readFileSync = options.readFileSync ?? nodeReadFileSync;
  const explicitPath = readString(config.configFile) ?? readString(env.TELEGRAM_CALL_CONFIG_FILE);
  const filePath = explicitPath
    ? resolveConfigPath(explicitPath, baseDir)
    : resolveConfigPath(DEFAULT_CONFIG_FILE, baseDir);

  if (!explicitPath && !existsSync(filePath)) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (error) {
    error.message = `Failed to read Telegram call config file ${filePath}: ${error.message}`;
    throw error;
  }

  if (!isRecord(parsed)) {
    throw new Error(`Telegram call config file ${filePath} must contain a JSON object`);
  }
  return parsed;
}

export function mergeTelegramCallConfig(fileConfig = {}, inlineConfig = {}) {
  const fromFile = isRecord(fileConfig) ? fileConfig : {};
  const inline = isRecord(inlineConfig) ? inlineConfig : {};
  const merged = {
    ...fromFile,
    ...inline,
  };
  const fileProfiles = isRecord(fromFile.callProfiles) ? fromFile.callProfiles : {};
  const inlineProfiles = isRecord(inline.callProfiles) ? inline.callProfiles : {};
  if (Object.keys(fileProfiles).length > 0 || Object.keys(inlineProfiles).length > 0) {
    merged.callProfiles = readBoolean(merged.preferFileCallProfiles) === true
      ? mergeProfileSets(inlineProfiles, fileProfiles)
      : mergeProfileSets(fileProfiles, inlineProfiles);
  }
  return merged;
}

function mergeProfileSets(fileProfiles, inlineProfiles) {
  const profileIds = new Set([
    ...Object.keys(fileProfiles),
    ...Object.keys(inlineProfiles),
  ]);
  const mergedProfiles = {};
  for (const profileId of profileIds) {
    const fromFile = fileProfiles[profileId];
    const inline = inlineProfiles[profileId];
    mergedProfiles[profileId] = isRecord(fromFile) && isRecord(inline)
      ? { ...fromFile, ...inline }
      : inline ?? fromFile;
  }
  return mergedProfiles;
}

function resolveConfigPath(filePath, baseDir) {
  return isAbsolute(filePath) ? filePath : resolve(baseDir, filePath);
}

function readEnvTelegramCallConfig(env = {}) {
  return compactRecord({
    publicBaseUrl: readString(env.TELEGRAM_CALL_PUBLIC_BASE_URL),
    defaultProfile: readString(env.TELEGRAM_CALL_DEFAULT_PROFILE),
    callProfiles: readJsonObject(env.TELEGRAM_CALL_PROFILES_JSON, 'TELEGRAM_CALL_PROFILES_JSON'),
    preferFileCallProfiles: readBoolean(env.TELEGRAM_CALL_PREFER_FILE_PROFILES),
    callTokenTtlSeconds: readInteger(env.TELEGRAM_CALL_TOKEN_TTL_SECONDS),
    agentSpeechChunkMode: readString(env.TELEGRAM_CALL_AGENT_SPEECH_CHUNK_MODE),
    telegramBotToken: readString(env.TELEGRAM_BOT_TOKEN),
    telegramChatId: readString(env.TELEGRAM_CALL_CHAT_ID),
    telegramButtonText: readString(env.TELEGRAM_CALL_BUTTON_TEXT),
    telegramMessageText: readString(env.TELEGRAM_CALL_MESSAGE_TEXT),
    telegramDisableNotification: readBoolean(env.TELEGRAM_CALL_DISABLE_NOTIFICATION),
    telegramBotApiBaseUrl: readString(env.TELEGRAM_BOT_API_BASE_URL),
    telegramAccountId: readString(env.TELEGRAM_CALL_ACCOUNT_ID),
    telegramMirrorReplies: readBoolean(env.TELEGRAM_CALL_MIRROR_REPLIES),
  }) ?? {};
}

function readInteger(value) {
  const text = readString(value);
  if (!text) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function readJsonObject(value, name) {
  const text = readString(value);
  if (!text) {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${name} must contain a JSON object: ${error.message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${name} must contain a JSON object`);
  }
  return parsed;
}
