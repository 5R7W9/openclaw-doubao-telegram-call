import { createTelegramCallRuntime } from './runtime.js';
import { resolvePluginConfig, resolveRootConfig } from './routes.js';
import { resolveTelegramDeliveryConfig } from './telegram-config.js';
import { sendTelegramCallLaunch } from './telegram-bot.js';
import {
  compactObject,
  isRecord,
  readChatId,
  readString,
} from '../values.js';

export const TELEGRAM_CALL_TOOL_NAMES = Object.freeze([
  'create_telegram_call_link',
  'send_telegram_call_card',
  'list_telegram_call_profiles',
]);

export function registerTelegramCallTools(api, options = {}) {
  if (typeof api?.registerTool !== 'function') {
    return false;
  }

  const runtime = options.runtime ?? createTelegramCallRuntime({
    config: resolvePluginConfig(api),
  });
  const rootConfig = options.rootConfig ?? resolveRootConfig(api);
  const telegramSender = options.telegramSender ?? sendTelegramCallLaunch;

  api.registerTool({
    name: 'create_telegram_call_link',
    description: 'Create a Telegram Mini App voice call link for a configured OpenClaw call profile without sending a Telegram message.',
    parameters: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: 'Call profile id. Defaults to the plugin default profile.',
        },
        chatId: {
          anyOf: [{ type: 'string' }, { type: 'number' }],
          description: 'Optional Telegram chat id to attach to the pending call.',
        },
        userId: {
          type: 'string',
          description: 'Optional caller/user id for call bookkeeping.',
        },
        baseUrl: {
          type: 'string',
          description: 'Optional public Gateway base URL. Defaults to plugin publicBaseUrl.',
        },
      },
    },
    async execute(idOrParams, maybeParams) {
      const params = normalizeExecuteParams(idOrParams, maybeParams);
      try {
        const launch = createCallLaunch({ runtime, params, requireUrl: true });
        return toolJson({
          ok: true,
          ...summarizeLaunch(launch),
        });
      } catch (error) {
        return toolJson(toolError(error, 'telegram_call_link_failed'));
      }
    },
  });

  api.registerTool({
    name: 'send_telegram_call_card',
    description: 'Send a Telegram Mini App voice call card to the configured Telegram chat for an OpenClaw call profile.',
    parameters: {
      type: 'object',
      properties: {
        profileId: {
          type: 'string',
          description: 'Call profile id. Defaults to the plugin default profile.',
        },
        chatId: {
          anyOf: [{ type: 'string' }, { type: 'number' }],
          description: 'Optional Telegram chat id override.',
        },
        userId: {
          type: 'string',
          description: 'Optional caller/user id for call bookkeeping.',
        },
        baseUrl: {
          type: 'string',
          description: 'Optional public Gateway base URL. Defaults to plugin publicBaseUrl.',
        },
        telegramAccountId: {
          type: 'string',
          description: 'Optional Telegram account id override from OpenClaw channel config.',
        },
        telegramButtonText: {
          type: 'string',
          description: 'Optional Telegram inline button label.',
        },
        telegramMessageText: {
          type: 'string',
          description: 'Optional Telegram message text. Use {label} for the call profile label.',
        },
        telegramDisableNotification: {
          type: 'boolean',
          description: 'Whether Telegram should send the call card silently.',
        },
      },
    },
    async execute(idOrParams, maybeParams) {
      const params = normalizeExecuteParams(idOrParams, maybeParams);
      try {
        const profile = runtime.resolveProfile(readProfileId(params));
        const telegram = resolveTelegramDeliveryConfig({
          body: params,
          profile,
          rootConfig,
          runtimeConfig: runtime.config,
        });
        const validationFailure = validateTelegramLaunchConfig(telegram.config);
        if (validationFailure) {
          return toolJson(validationFailure);
        }

        const launch = createCallLaunch({
          runtime,
          params: {
            ...params,
            profileId: profile.id,
            chatId: telegram.config.chatId,
          },
          requireUrl: true,
        });
        const sendResult = await telegramSender({
          config: telegram.config,
          env: telegram.env,
          launch,
        });

        return toolJson({
          ok: true,
          ...summarizeLaunch(launch, { includeUrl: false }),
          telegram: compactObject({
            messageId: sendResult?.messageId,
            chatId: sendResult?.chatId,
          }),
        });
      } catch (error) {
        return toolJson(toolError(error, 'telegram_call_send_failed'));
      }
    },
  });

  api.registerTool({
    name: 'list_telegram_call_profiles',
    description: 'List configured Telegram voice call profiles that can be used with the call link and call card tools.',
    parameters: {
      type: 'object',
      properties: {},
    },
    async execute() {
      return toolJson({
        ok: true,
        defaultProfile: runtime.profileSet.defaultProfileId,
        profiles: Object.values(runtime.profileSet.profiles).map(summarizeProfile),
      });
    },
  });

  return true;
}

function createCallLaunch({ runtime, params, requireUrl }) {
  const baseUrl = resolveToolBaseUrl(params, runtime);
  if (requireUrl && !baseUrl) {
    const error = new Error('Telegram call publicBaseUrl is not configured. Pass baseUrl or set plugins.entries.doubao-telegram-call.config.publicBaseUrl.');
    error.code = 'telegram_call_public_base_url_missing';
    throw error;
  }
  return runtime.createCall({
    profileId: readProfileId(params),
    chatId: readChatId(params.chatId),
    userId: readString(params.userId),
    baseUrl,
  });
}

function resolveToolBaseUrl(params, runtime) {
  return readString(params.baseUrl) ?? readString(runtime.config?.publicBaseUrl);
}

function validateTelegramLaunchConfig(config) {
  if (!readString(config?.botToken)) {
    return {
      ok: false,
      code: 'telegram_bot_not_configured',
      message: 'Telegram bot token is not configured',
    };
  }
  if (readChatId(config?.chatId) === undefined) {
    return {
      ok: false,
      code: 'telegram_chat_not_configured',
      message: 'Telegram chat id is not configured',
    };
  }
  return undefined;
}

function summarizeLaunch(launch, options = {}) {
  return compactObject({
    callId: launch.callId,
    url: options.includeUrl === false ? undefined : launch.url,
    expiresAt: launch.expiresAt,
    profile: summarizeProfile(launch.profile),
  });
}

function summarizeProfile(profile) {
  return compactObject({
    id: profile.id,
    label: profile.label,
    avatarUrl: profile.avatarUrl,
    avatarText: profile.avatarText,
    agentId: profile.agentId,
    sessionId: profile.sessionId,
    sessionKey: profile.sessionKey,
    providerId: profile.providerId,
    speaker: profile.speaker,
    model: profile.model,
    telegramAccountId: profile.telegramAccountId,
    greeting: profile.greeting,
    instructions: profile.instructions,
    maxDurationSeconds: profile.maxDurationSeconds,
  });
}

function normalizeExecuteParams(idOrParams, maybeParams) {
  if (isRecord(maybeParams)) {
    return maybeParams;
  }
  if (isRecord(idOrParams)) {
    return idOrParams;
  }
  return {};
}

function toolJson(payload) {
  return {
    content: [{
      type: 'text',
      text: JSON.stringify(payload, null, 2),
    }],
  };
}

function toolError(error, fallbackCode) {
  return {
    ok: false,
    code: readString(error?.code) ?? fallbackCode,
    message: errorMessage(error),
  };
}

function errorMessage(error) {
  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message.trim();
  }
  return 'Telegram call tool failed';
}

function readProfileId(params) {
  return readString(params.profileId) ?? readString(params.profile);
}
