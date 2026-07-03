import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from 'node:crypto';

import {
  DEFAULT_CALL_MAX_DURATION_SECONDS,
  DEFAULT_CALL_TOKEN_TTL_MS,
  DEFAULT_PROFILE_ID,
  REALTIME_PROVIDER_ID,
  RELAY_PROTOCOL,
  RELAY_AUDIO_CONTRACT,
  RELAY_ROUTE_PATH,
  ROUTE_PREFIX,
} from './constants.js';
import {
  compactObject,
  isRecord,
  readBoolean,
  readChatId,
  readString,
} from '../values.js';

const CALL_TOKEN_PREFIX = 'ctc_';
const O2_REALTIME_MODEL = '1.2.1.1';

export function createTelegramCallRuntime(options = {}) {
  return new TelegramCallRuntime(options);
}

export class TelegramCallRuntime {
  constructor(options = {}) {
    this.config = normalizeRuntimeConfig(options.config);
    this.profileSet = normalizeCallProfiles(this.config);
    this.calls = new Map();
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.randomBytes = typeof options.randomBytes === 'function' ? options.randomBytes : nodeRandomBytes;
    this.tokenSecret = readString(options.tokenSecret) ?? base64url(nodeRandomBytes(32));
  }

  createCall(params = {}) {
    const profile = this.resolveProfile(params.profileId);
    const createdAtMs = this.now();
    const ttlMs = readPositiveInteger(this.config.callTokenTtlSeconds) !== undefined
      ? this.config.callTokenTtlSeconds * 1000
      : DEFAULT_CALL_TOKEN_TTL_MS;
    const expiresAtMs = createdAtMs + ttlMs;
    const callId = `call_${base64url(this.randomBytes(16))}`;
    const nonce = base64url(this.randomBytes(24));
    const signature = this.signToken({ callId, nonce, profileId: profile.id, expiresAtMs });
    const token = `${CALL_TOKEN_PREFIX}${nonce}.${signature}`;
    const call = {
      callId,
      tokenHash: hashToken(token),
      profile,
      profileId: profile.id,
      chatId: readChatId(params.chatId),
      userId: readString(params.userId),
      createdAtMs,
      expiresAtMs,
      state: 'pending',
    };
    this.calls.set(callId, call);

    return {
      callId,
      token,
      expiresAt: toEpochSeconds(expiresAtMs),
      profile: publicProfile(profile),
      ...(params.baseUrl ? { url: buildMiniAppUrl(params.baseUrl, { callId, token, profileId: profile.id }) } : {}),
    };
  }

  answerCall(params = {}) {
    const call = this.calls.get(readString(params.callId));
    if (!call) {
      return failure('call_not_found', 'Call not found', 404);
    }
    const tokenFailure = this.validateCallToken(call, params.token);
    if (tokenFailure) {
      return tokenFailure;
    }
    if (readString(params.profileId) && params.profileId !== call.profileId) {
      return failure('call_profile_mismatch', 'Call token does not match this profile', 403);
    }
    if (call.state === 'ended') {
      return failure('call_ended', 'Call already ended', 409);
    }
    if (call.state === 'answered' || call.state === 'active') {
      return failure('call_already_answered', 'Call already answered or closed', 409);
    }

    call.state = 'answered';
    call.answeredAtMs = this.now();
    return {
      ok: true,
      status: 200,
      payload: buildGatewayRelayBootstrap(call),
    };
  }

  openRelayCall(params = {}) {
    const call = this.calls.get(readString(params.callId));
    if (!call) {
      return failure('call_not_found', 'Call not found', 404);
    }
    const tokenFailure = this.validateCallToken(call, params.token);
    if (tokenFailure) {
      return tokenFailure;
    }
    if (readString(params.profileId) && params.profileId !== call.profileId) {
      return failure('call_profile_mismatch', 'Call token does not match this profile', 403);
    }
    if (call.state === 'active') {
      return failure('call_already_active', 'Call already active', 409);
    }
    if (call.state !== 'pending' && call.state !== 'answered') {
      return failure('call_not_answerable', 'Call cannot be opened', 409);
    }

    if (!call.answeredAtMs) {
      call.answeredAtMs = this.now();
    }
    call.state = 'active';
    call.relayOpenedAtMs = this.now();
    return {
      ok: true,
      status: 200,
      payload: buildGatewayRelayBootstrap(call),
    };
  }

  getCall(callId) {
    return this.calls.get(readString(callId));
  }

  closeCall(callId) {
    const call = this.calls.get(readString(callId));
    if (!call) {
      return undefined;
    }
    call.state = 'ended';
    call.endedAtMs = call.endedAtMs ?? this.now();
    return call;
  }

  hangupCall(params = {}) {
    const call = this.calls.get(readString(params.callId));
    if (!call) {
      return failure('call_not_found', 'Call not found', 404);
    }
    const tokenFailure = this.validateCallToken(call, params.token, { allowEnded: true });
    if (tokenFailure) {
      return tokenFailure;
    }
    call.state = 'ended';
    call.endedAtMs = call.endedAtMs ?? this.now();
    return {
      ok: true,
      status: 200,
      payload: {
        callId: call.callId,
        state: call.state,
        endedAt: toEpochSeconds(call.endedAtMs),
      },
    };
  }

  resolveProfile(profileId) {
    const requested = readString(profileId) ?? this.profileSet.defaultProfileId;
    return this.profileSet.profiles[requested] ?? this.profileSet.profiles[this.profileSet.defaultProfileId];
  }

  validateCallToken(call, token, options = {}) {
    if (call.expiresAtMs <= this.now() && call.state !== 'ended') {
      call.state = 'expired';
      return failure('call_expired', 'Call expired', 410);
    }
    if (call.state === 'expired') {
      return failure('call_expired', 'Call expired', 410);
    }
    if (call.state === 'ended' && options.allowEnded !== true) {
      return failure('call_ended', 'Call already ended', 409);
    }

    const parsed = parseToken(token);
    if (!parsed) {
      return failure('invalid_token', 'Invalid call token', 401);
    }
    const expectedSignature = this.signToken({
      callId: call.callId,
      nonce: parsed.nonce,
      profileId: call.profileId,
      expiresAtMs: call.expiresAtMs,
    });
    if (!safeEqual(parsed.signature, expectedSignature) || hashToken(token) !== call.tokenHash) {
      return failure('invalid_token', 'Invalid call token', 401);
    }
    return undefined;
  }

  signToken({ callId, nonce, profileId, expiresAtMs }) {
    return base64url(createHmac('sha256', this.tokenSecret)
      .update(`${callId}.${nonce}.${profileId}.${expiresAtMs}`)
      .digest());
  }
}

export function normalizeCallProfiles(config = {}) {
  const rawProfiles = isRecord(config.callProfiles) ? config.callProfiles : {};
  const profiles = {};
  for (const [id, rawProfile] of Object.entries(rawProfiles)) {
    const normalizedId = readString(id);
    if (!normalizedId || !isRecord(rawProfile)) {
      continue;
    }
    profiles[normalizedId] = normalizeCallProfile(normalizedId, rawProfile);
  }

  if (Object.keys(profiles).length === 0) {
    profiles[DEFAULT_PROFILE_ID] = normalizeCallProfile(DEFAULT_PROFILE_ID, {
      label: 'OpenClaw',
      agentId: 'main',
    });
  }

  const configuredDefault = readString(config.defaultProfile);
  const defaultProfileId = configuredDefault && profiles[configuredDefault]
    ? configuredDefault
    : Object.keys(profiles)[0];

  return {
    defaultProfileId,
    profiles,
  };
}

export function buildGatewayRelayBootstrap(call) {
  const profile = call.profile;
  const createParams = compactObject({
    mode: 'realtime',
    transport: 'gateway-relay',
    brain: 'agent-consult',
    provider: profile.providerId,
    sessionKey: profile.sessionKey,
    model: profile.model,
    voice: profile.speaker,
  });

  return {
    call: compactObject({
      callId: call.callId,
      profileId: profile.id,
      label: profile.label,
      avatarUrl: profile.avatarUrl,
      avatarText: profile.avatarText,
      state: call.state,
      expiresAt: toEpochSeconds(call.expiresAtMs),
      answeredAt: call.answeredAtMs ? toEpochSeconds(call.answeredAtMs) : undefined,
      maxDurationSeconds: profile.maxDurationSeconds,
      instructions: profile.instructions,
      greeting: profile.greeting,
    }),
    gatewayRelay: {
      provider: profile.providerId,
      transport: 'gateway-relay',
      mode: 'realtime',
      brain: 'agent-consult',
      create: {
        method: 'talk.session.create',
        params: createParams,
      },
      methods: {
        appendAudio: 'talk.session.appendAudio',
        cancelTurn: 'talk.session.cancelTurn',
        cancelOutput: 'talk.session.cancelOutput',
        close: 'talk.session.close',
        steer: 'talk.session.steer',
      },
      audio: { ...RELAY_AUDIO_CONTRACT },
    },
    pluginRelay: {
      url: RELAY_ROUTE_PATH,
      protocol: RELAY_PROTOCOL,
      methods: {
        audio: 'audio',
        cancelOutput: 'cancelOutput',
        hangup: 'hangup',
      },
      audio: { ...RELAY_AUDIO_CONTRACT },
    },
  };
}

export function buildMiniAppUrl(baseUrl, { callId, token, profileId }) {
  const url = new URL(ROUTE_PREFIX.endsWith('/') ? ROUTE_PREFIX : `${ROUTE_PREFIX}/`, normalizeBaseUrl(baseUrl));
  url.searchParams.set('callId', callId);
  url.searchParams.set('token', token);
  if (profileId) {
    url.searchParams.set('profile', profileId);
  }
  return url.toString();
}

function normalizeCallProfile(id, rawProfile) {
  const agentId = readString(rawProfile.agentId) ?? (id === DEFAULT_PROFILE_ID ? 'main' : id);
  const sessionId = readString(rawProfile.sessionId) ?? 'main';
  const speaker = readString(rawProfile.speaker) ?? readString(rawProfile.voice);
  return compactObject({
    id,
    label: readString(rawProfile.label) ?? id,
    avatarUrl: readString(rawProfile.avatarUrl) ?? readString(rawProfile.avatar),
    avatarText: readString(rawProfile.avatarText),
    agentId,
    sessionId,
    sessionKey: readString(rawProfile.sessionKey) ?? `agent:${agentId}:${sessionId}`,
    providerId: readString(rawProfile.providerId) ?? REALTIME_PROVIDER_ID,
    speaker,
    model: readString(rawProfile.model) ?? inferRealtimeModelForSpeaker(speaker),
    telegramAccountId: readString(rawProfile.telegramAccountId) ?? readString(rawProfile.replyAccountId),
    telegramBotToken: readString(rawProfile.telegramBotToken) ?? readString(rawProfile.botToken),
    telegramChatId: readString(rawProfile.telegramChatId) ?? readString(rawProfile.chatId),
    telegramButtonText: readString(rawProfile.telegramButtonText) ?? readString(rawProfile.buttonText),
    telegramMessageText: readString(rawProfile.telegramMessageText) ?? readString(rawProfile.messageText),
    telegramDisableNotification: readBoolean(rawProfile.telegramDisableNotification)
      ?? readBoolean(rawProfile.disableNotification),
    telegramMirrorReplies: readBoolean(rawProfile.telegramMirrorReplies),
    agentSpeechChunkMode: readString(rawProfile.agentSpeechChunkMode) ?? readString(rawProfile.speechChunkMode),
    greeting: readString(rawProfile.greeting),
    instructions: readString(rawProfile.instructions),
    maxDurationSeconds: readPositiveInteger(rawProfile.maxDurationSeconds) ?? DEFAULT_CALL_MAX_DURATION_SECONDS,
  });
}

function inferRealtimeModelForSpeaker(speaker) {
  return readString(speaker)?.endsWith('_uranus_bigtts') ? O2_REALTIME_MODEL : undefined;
}

function normalizeRuntimeConfig(config = {}) {
  return isRecord(config) ? config : {};
}

function publicProfile(profile) {
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

function parseToken(token) {
  const raw = readString(token);
  if (!raw || !raw.startsWith(CALL_TOKEN_PREFIX)) {
    return undefined;
  }
  const [nonce, signature] = raw.slice(CALL_TOKEN_PREFIX.length).split('.');
  if (!nonce || !signature) {
    return undefined;
  }
  return { nonce, signature };
}

function failure(code, message, status) {
  return { ok: false, code, message, status };
}

function hashToken(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function normalizeBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

function toEpochSeconds(timestampMs) {
  return Math.floor(timestampMs / 1000);
}

function readPositiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined;
}
