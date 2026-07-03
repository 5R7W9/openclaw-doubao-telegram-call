import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  PLUGIN_ID,
  RELAY_ROUTE_PATH,
  ROUTE_PREFIX,
} from './constants.js';
import { resolveTelegramCallConfig } from './config-file.js';
import { createTelegramCallRelayUpgradeHandler } from './relay.js';
import { createTelegramCallRuntime } from './runtime.js';
import { resolveTelegramDeliveryConfig } from './telegram-config.js';
import {
  sendTelegramCallLaunch,
} from './telegram-bot.js';
import {
  compactRecord,
  isRecord,
  readString,
} from '../values.js';

const MAX_JSON_BODY_BYTES = 16 * 1024;
const INDEX_PATH = fileURLToPath(new URL('../../web/telegram-call/index.html', import.meta.url));
const ASSETS = new Map([
  ['/assets/app.js', {
    path: fileURLToPath(new URL('../../web/telegram-call/app.js', import.meta.url)),
    contentType: 'application/javascript; charset=utf-8',
  }],
  ['/assets/relay.js', {
    path: fileURLToPath(new URL('../../web/telegram-call/relay.js', import.meta.url)),
    contentType: 'application/javascript; charset=utf-8',
  }],
  ['/assets/styles.css', {
    path: fileURLToPath(new URL('../../web/telegram-call/styles.css', import.meta.url)),
    contentType: 'text/css; charset=utf-8',
  }],
  ['/assets/pcm-worklet.js', {
    path: fileURLToPath(new URL('../../web/telegram-call/pcm-worklet.js', import.meta.url)),
    contentType: 'application/javascript; charset=utf-8',
  }],
]);

export function registerTelegramCallRoutes(api, options = {}) {
  if (typeof api?.registerHttpRoute !== 'function') {
    return false;
  }
  const runtime = options.runtime ?? createTelegramCallRuntime({
    config: resolvePluginConfig(api),
  });
  const rootConfig = resolveRootConfig(api);
  const relayUpgradeHandler = options.relayUpgradeHandler ?? createTelegramCallRelayUpgradeHandler({
    config: rootConfig,
    runtime,
  });
  const telegramSender = options.telegramSender ?? sendTelegramCallLaunch;
  const clientLogSink = options.clientLogSink ?? createClientLogSink(api);

  const indexHandler = async (req, res) => {
    if (!allowMethods(req, res, ['GET', 'HEAD'])) {
      return true;
    }
    await serveFile(res, INDEX_PATH, 'text/html; charset=utf-8', { noStore: true, headOnly: req.method === 'HEAD' });
    return true;
  };

  api.registerHttpRoute({
    path: ROUTE_PREFIX,
    auth: 'plugin',
    match: 'exact',
    handler: indexHandler,
  });
  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/`,
    auth: 'plugin',
    match: 'exact',
    handler: indexHandler,
  });
  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/assets/`,
    auth: 'plugin',
    match: 'prefix',
    handler: async (req, res) => {
      if (!allowMethods(req, res, ['GET', 'HEAD'])) {
        return true;
      }
      const assetKey = readAssetKey(req.url);
      const asset = assetKey ? ASSETS.get(assetKey) : undefined;
      if (!asset) {
        writeJson(res, 404, { ok: false, code: 'asset_not_found', message: 'Asset not found' });
        return true;
      }
      await serveFile(res, asset.path, asset.contentType, { noStore: true, headOnly: req.method === 'HEAD' });
      return true;
    },
  });
  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/launch`,
    auth: 'gateway',
    match: 'exact',
    handler: async (req, res) => {
      if (!allowMethods(req, res, ['POST'])) {
        return true;
      }
      const body = await readJsonBody(req);
      const launch = runtime.createCall({
        profileId: body.profileId ?? body.profile,
        chatId: body.chatId,
        userId: body.userId,
        baseUrl: resolveLaunchBaseUrl(req, runtime, body),
      });
      writeJson(res, 200, {
        ok: true,
        ...launch,
      });
      return true;
    },
  });
  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/launch/send`,
    auth: 'gateway',
    match: 'exact',
    handler: async (req, res) => {
      if (!allowMethods(req, res, ['POST'])) {
        return true;
      }
      const body = await readJsonBody(req);
      const profile = runtime.resolveProfile(body.profileId ?? body.profile);
      const telegramLaunch = resolveTelegramDeliveryConfig({
        body,
        profile,
        rootConfig,
        runtimeConfig: runtime.config,
      });
      const launch = runtime.createCall({
        profileId: profile.id,
        chatId: telegramLaunch.config.chatId,
        userId: body.userId,
        baseUrl: resolveLaunchBaseUrl(req, runtime, body),
      });
      try {
        const sendResult = await telegramSender({
          config: telegramLaunch.config,
          launch,
          env: telegramLaunch.env,
        });
        writeJson(res, 200, {
          ok: true,
          ...launch,
          telegram: sendResult,
        });
      } catch (error) {
        writeJson(res, error.status && error.status >= 400 && error.status < 600 ? error.status : 503, {
          ok: false,
          code: error.code ?? 'telegram_send_failed',
          message: error.message ?? 'Telegram call invite failed',
        });
      }
      return true;
    },
  });
  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/answer`,
    auth: 'plugin',
    match: 'exact',
    handler: async (req, res) => {
      if (!allowMethods(req, res, ['POST'])) {
        return true;
      }
      const body = await readJsonBody(req);
      const result = runtime.answerCall({
        callId: body.callId,
        token: body.token,
        profileId: body.profileId ?? body.profile,
        telegramInitData: body.telegramInitData,
      });
      writeRuntimeResult(res, result);
      return true;
    },
  });
  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/hangup`,
    auth: 'plugin',
    match: 'exact',
    handler: async (req, res) => {
      if (!allowMethods(req, res, ['POST'])) {
        return true;
      }
      const body = await readJsonBody(req);
      const result = runtime.hangupCall({
        callId: body.callId,
        token: body.token,
      });
      writeRuntimeResult(res, result);
      return true;
    },
  });
  api.registerHttpRoute({
    path: `${ROUTE_PREFIX}/client-log`,
    auth: 'plugin',
    match: 'exact',
    handler: async (req, res) => {
      if (!allowMethods(req, res, ['POST'])) {
        return true;
      }
      const body = await readJsonBody(req);
      const entry = normalizeClientLog(body);
      if (entry) {
        clientLogSink(entry);
      }
      writeJson(res, 200, { ok: true });
      return true;
    },
  });
  api.registerHttpRoute({
    path: RELAY_ROUTE_PATH,
    auth: 'plugin',
    match: 'exact',
    handleUpgrade: relayUpgradeHandler,
    handler: async (_req, res) => {
      writeJson(res, 426, {
        ok: false,
        code: 'upgrade_required',
        message: 'WebSocket upgrade required',
      });
      return true;
    },
  });

  return true;
}

export function resolvePluginConfig(api) {
  const direct = api?.pluginConfig;
  if (isRecord(direct)) {
    return resolveTelegramCallConfig(direct);
  }
  const entryConfig = api?.config?.plugins?.entries?.[PLUGIN_ID]?.config;
  return resolveTelegramCallConfig(isRecord(entryConfig) ? entryConfig : {});
}

export function resolveRootConfig(api) {
  return isRecord(api?.config) ? api.config : {};
}

function writeRuntimeResult(res, result) {
  if (result.ok) {
    writeJson(res, result.status ?? 200, {
      ok: true,
      ...result.payload,
    });
    return;
  }
  writeJson(res, result.status ?? 400, {
    ok: false,
    code: result.code,
    message: result.message,
  });
}

async function serveFile(res, filePath, contentType, options = {}) {
  const body = options.headOnly ? undefined : await readFile(filePath);
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', options.noStore ? 'no-store' : 'public, max-age=60');
  res.end(body);
}

function allowMethods(req, res, methods) {
  if (methods.includes(req.method)) {
    return true;
  }
  res.statusCode = 405;
  res.setHeader('Allow', methods.join(', '));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({ ok: false, code: 'method_not_allowed', message: 'Method not allowed' }));
  return false;
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_JSON_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function writeJson(res, statusCode, body) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function createClientLogSink(api) {
  const logger = api?.logger ?? console;
  return (entry) => {
    const line = `[doubao-telegram-call/client] ${JSON.stringify(entry)}`;
    if (typeof logger.warn === 'function') {
      logger.warn(line);
      return;
    }
    if (typeof logger.log === 'function') {
      logger.log(line);
    }
  };
}

function normalizeClientLog(body) {
  if (!isRecord(body)) {
    return undefined;
  }
  return compactRecord({
    callId: limitString(body.callId, 96),
    profileId: limitString(body.profileId ?? body.profile, 80),
    stage: limitString(body.stage, 80),
    atMs: limitNumber(body.atMs, 0, 24 * 60 * 60 * 1000),
    name: limitString(body.name, 120),
    message: limitString(body.message, 300),
  });
}

function limitString(value, maxLength) {
  const text = readString(value);
  if (!text) {
    return undefined;
  }
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function limitNumber(value, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < min || value > max) {
    return undefined;
  }
  return Math.round(value);
}

function readAssetKey(url) {
  const pathname = new URL(url ?? '/', 'http://localhost').pathname;
  if (!pathname.startsWith(ROUTE_PREFIX)) {
    return undefined;
  }
  return pathname.slice(ROUTE_PREFIX.length);
}

function resolveLaunchBaseUrl(req, runtime, body) {
  return readString(body.baseUrl)
    ?? readString(runtime.config?.publicBaseUrl)
    ?? inferRequestBaseUrl(req);
}

function inferRequestBaseUrl(req) {
  const host = readHeader(req.headers?.['x-forwarded-host']) ?? readHeader(req.headers?.host);
  if (!host) {
    return undefined;
  }
  const proto = readHeader(req.headers?.['x-forwarded-proto']) ?? (req.socket?.encrypted ? 'https' : 'http');
  return `${proto}://${host}`;
}

function readHeader(value) {
  if (Array.isArray(value)) {
    return readString(value[0]);
  }
  return readString(value);
}
