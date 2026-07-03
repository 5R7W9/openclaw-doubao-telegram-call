import { WebSocketServer } from 'ws';

import { RELAY_PROTOCOL } from './constants.js';
import { createGatewayRpcSocket } from './gateway-client.js';
import { createLatencyTracker } from './latency.js';
import { resolveTelegramDeliveryConfig } from './telegram-config.js';
import { sendTelegramTextMessage } from './telegram-bot.js';
import {
  isRecord,
  readBoolean,
  readString,
} from '../values.js';

const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
const AUDIO_APPEND_TIMEOUT_MS = 10_000;
const OPENCLAW_AGENT_CONSULT_TOOL = 'openclaw_agent_consult';
const OPENCLAW_AGENT_CONTROL_TOOL = 'openclaw_agent_control';
const HANGUP_AGENT_MESSAGE = '电话已挂断。';
const HANGUP_AGENT_NOTIFY_TIMEOUT_MS = 1500;

export function createTelegramCallRelayUpgradeHandler(options = {}) {
  const server = new (options.WebSocketServerCtor ?? WebSocketServer)({ noServer: true });
  return function handleTelegramCallRelayUpgrade(req, socket, head) {
    server.handleUpgrade(req, socket, head, (ws) => {
      const relay = createTelegramCallRelaySession(options);
      relay.start(ws, parseRelayRequestUrl(req.url)).catch((error) => {
        sendJson(ws, {
          type: 'error',
          code: 'relay_start_failed',
          message: errorMessage(error),
        });
        closeSocket(ws);
      });
    });
    return true;
  };
}

export function createTelegramCallRelaySession(options = {}) {
  return new TelegramCallRelaySession(options);
}

export class TelegramCallRelaySession {
  constructor(options = {}) {
    this.runtime = options.runtime;
    this.config = options.config ?? {};
    this.gatewayClientFactory = options.gatewayClientFactory ?? ((params) => createGatewayRpcSocket({
      config: this.config,
      onEvent: params?.onEvent,
    }));
    this.socket = null;
    this.gateway = null;
    this.unsubscribeGateway = null;
    this.callId = null;
    this.sessionKey = null;
    this.profile = null;
    this.relaySessionId = null;
    this.closed = false;
    this.completedToolCalls = new Set();
    this.toolAbortControllers = new Map();
    this.toolRunIds = new Map();
    this.toolLatencyMarks = new Set();
    this.providerLatencyMarks = new Set();
    this.relayAudioLatencyMarks = new Set();
    this.latestProviderTurnIndex = undefined;
    this.agentHangupNotified = false;
    this.telegramTextSender = options.telegramTextSender ?? sendTelegramTextMessage;
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => Date.now());
    this.latency = createLatencyTracker({
      logger: this.logger,
      now: this.now,
      component: 'relay',
    });
  }

  async start(socket, params = {}) {
    this.socket = socket;
    this.callId = params.callId;
    this.attachSocket(socket);

    const opened = this.runtime?.openRelayCall?.({
      callId: params.callId,
      token: params.token,
      profileId: params.profileId,
    });
    if (!opened?.ok) {
      sendJson(socket, {
        type: 'error',
        code: opened?.code ?? 'invalid_call',
        message: opened?.message ?? 'Invalid call',
      });
      closeSocket(socket);
      return;
    }

    const bootstrap = opened.payload;
    this.profile = this.runtime?.getCall?.(this.callId)?.profile ?? null;
    const create = bootstrap.gatewayRelay.create;
    this.sessionKey = create.params?.sessionKey;
    this.latency.setContext({
      callId: this.callId,
      profileId: bootstrap.call?.profileId ?? params.profileId,
      sessionKey: this.sessionKey,
    });
    this.latency.markOnce('relay_start');
    try {
      this.sendState('gateway_connecting');
      this.gateway = this.gatewayClientFactory({});
      this.unsubscribeGateway = this.gateway.addEventListener?.((frame) => this.handleGatewayEvent(frame));
      await this.gateway.connect();
      this.latency.markOnce('gateway_connected');

      this.sendState('relay_connecting');
      const session = await this.gateway.request(create.method, create.params);
      this.relaySessionId = session.relaySessionId ?? session.sessionId;
      if (!this.relaySessionId) {
        throw new Error('Gateway relay did not return a session id');
      }
      this.latency.setContext({
        relaySessionId: this.relaySessionId,
      });
      this.latency.markOnce('relay_session_created');
      this.sendSession({
        call: bootstrap.call,
        session,
        audio: session.audio ?? bootstrap.pluginRelay.audio,
      });
    } catch (error) {
      await this.stop({ closeSocket: false, closeGatewaySession: false });
      throw error;
    }
  }

  attachSocket(socket) {
    addSocketListener(socket, 'message', (data) => {
      void this.handleClientMessage(data);
    });
    addSocketListener(socket, 'close', () => {
      void this.stop({ closeSocket: false });
    });
    addSocketListener(socket, 'error', () => {
      void this.stop({ closeSocket: false });
    });
  }

  async handleClientMessage(data) {
    const message = parseJsonFrame(data);
    if (!message || this.closed) {
      return;
    }
    switch (message.type) {
      case 'audio':
        await this.appendAudio(message);
        return;
      case 'cancelOutput':
        await this.cancelOutput(message.reason);
        return;
      case 'hangup':
        await this.stop();
        return;
      default:
        sendJson(this.socket, {
          type: 'error',
          code: 'unknown_message',
          message: `Unknown relay message: ${message.type ?? 'unknown'}`,
        });
    }
  }

  async appendAudio(message) {
    if (!this.relaySessionId || !message.audioBase64) {
      return;
    }
    this.latency.markOnce('first_user_audio', {
      timestamp: Number.isFinite(message.timestamp) ? message.timestamp : undefined,
      audioBase64Chars: message.audioBase64.length,
    });
    await this.gateway.request('talk.session.appendAudio', {
      sessionId: this.relaySessionId,
      audioBase64: message.audioBase64,
      ...(Number.isFinite(message.timestamp) ? { timestamp: message.timestamp } : {}),
    }, { timeoutMs: AUDIO_APPEND_TIMEOUT_MS }).catch((error) => {
      this.sendError('audio_append_failed', errorMessage(error));
    });
  }

  async cancelOutput(reason) {
    if (!this.relaySessionId) {
      return;
    }
    await this.gateway.request('talk.session.cancelOutput', {
      sessionId: this.relaySessionId,
      reason: readString(reason) ?? 'barge-in',
    }).catch(() => undefined);
  }

  handleGatewayEvent(frame) {
    if (frame.event === 'talk.event') {
      this.handleTalkEvent(frame.payload);
      return;
    }
  }

  handleTalkEvent(event = {}) {
    if (!event || event.relaySessionId !== this.relaySessionId || this.closed) {
      return;
    }
    this.markLatencyFromTalkEvent(event);
    sendJson(this.socket, {
      type: 'relayEvent',
      event,
    });
    if (event.type === 'toolCall') {
      void this.handleToolCall(event);
      return;
    }
    if (event.type === 'close') {
      void this.stop({ closeSocket: false, closeGatewaySession: false });
    }
  }

  async handleToolCall(event) {
    const callId = readString(event.callId);
    const name = readString(event.name);
    if (!callId || !name || this.completedToolCalls.has(callId)) {
      return;
    }
    if (name === OPENCLAW_AGENT_CONTROL_TOOL) {
      await this.handleControlToolCall(event, callId);
      return;
    }
    if (name !== OPENCLAW_AGENT_CONSULT_TOOL) {
      await this.submitToolResult(callId, { error: `Tool "${name}" is not available` });
      return;
    }

    const emotionTag = readEmotionTag(event.args);
    this.latency.mark(emotionTag ? 'emotion_appended' : 'emotion_not_ready', {
      toolCallId: callId,
      ...(emotionTag ? { emotionTag } : {}),
      textChars: readString(event.args?.question)?.length,
    });
    this.latency.mark('agent_consult_start', {
      toolCallId: callId,
      ...(emotionTag ? { emotionTag } : {}),
    });
    const controller = new AbortController();
    const streamSpeech = event.forced !== true;
    const speechStreamer = streamSpeech
      ? new AgentSpeechStreamer({
        submitChunk: (text) => {
          this.markToolLatencyOnce(callId, 'first_agent_speech_chunk', {
            toolCallId: callId,
            textChars: normalizeRunText(text).length,
          });
          return this.submitToolResult(callId, {
            text,
            streamSpeech: true,
          }, { willContinue: true });
        },
      })
      : undefined;
    this.toolAbortControllers.set(callId, controller);
    try {
      if (event.forced === true) {
        await this.submitToolResult(callId, {
          status: 'working',
          tool: OPENCLAW_AGENT_CONSULT_TOOL,
          message: 'Checking with OpenClaw.',
        }, { willContinue: true });
      }
      const accepted = await this.gateway.request('talk.client.toolCall', {
        sessionKey: this.sessionKey,
        callId,
        name,
        args: appendProfileInstructions(normalizeToolArgs(event.args), this.profile?.instructions),
        relaySessionId: this.relaySessionId,
      });
      const runId = readString(accepted.runId) ?? readString(accepted.idempotencyKey);
      if (!runId) {
        throw new Error('OpenClaw did not return a run id');
      }
      this.toolRunIds.set(callId, runId);
      this.latency.mark('agent_consult_accepted', {
        toolCallId: callId,
        runId,
      });
      const text = await waitForAgentRunText({
        client: this.gateway,
        runId,
        timeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
        signal: controller.signal,
        onText: (partialText) => {
          this.markToolLatencyOnce(callId, 'agent_first_delta', {
            toolCallId: callId,
            runId,
            textChars: normalizeRunText(partialText).length,
          });
          speechStreamer?.offer(partialText);
        },
      });
      const remainingText = speechStreamer
        ? await speechStreamer.finish(text)
        : text;
      this.mirrorTelegramReply(text);
      if (speechStreamer) {
        const result = remainingText
          ? {
            text: remainingText,
            streamSpeech: true,
            streamSpeechEnd: true,
          }
          : {
            status: 'already_delivered',
            streamSpeechEnd: true,
          };
        await this.submitToolResult(callId, result, { suppressResponse: true });
      } else if (remainingText) {
        await this.submitToolResult(callId, { result: remainingText });
      } else {
        await this.submitToolResult(callId, { status: 'already_delivered' }, { suppressResponse: true });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        await this.submitToolResult(callId, { error: errorMessage(error) }).catch(() => undefined);
        this.sendError('tool_call_failed', errorMessage(error));
      }
    } finally {
      this.toolAbortControllers.delete(callId);
      this.toolRunIds.delete(callId);
    }
  }

  async handleControlToolCall(event, callId) {
    try {
      const args = normalizeControlArgs(event.args);
      const result = await this.gateway.request('talk.session.steer', {
        sessionId: this.relaySessionId,
        sessionKey: this.sessionKey,
        text: args.text,
        ...(args.mode ? { mode: args.mode } : {}),
      });
      await this.submitToolResult(callId, result);
    } catch (error) {
      await this.submitToolResult(callId, { error: errorMessage(error) }).catch(() => undefined);
    }
  }

  markLatencyFromTalkEvent(event = {}) {
    if (event.type === 'latency') {
      const mark = readString(event.mark) ?? readString(event.detail);
      if (mark) {
        const detail = {
          source: readString(event.source) ?? 'provider',
          turnIndex: readFiniteNumber(event.turnIndex),
          textChars: readFiniteNumber(event.textChars),
          audioBytes: readFiniteNumber(event.audioBytes),
          audioMs: readFiniteNumber(event.audioMs),
          status: readFiniteNumber(event.status),
          emotionTag: readString(event.emotionTag),
          reason: readString(event.reason),
        };
        if (detail.turnIndex !== undefined) {
          this.latestProviderTurnIndex = detail.turnIndex;
          const key = `${mark}:turn:${detail.turnIndex}`;
          if (!this.providerLatencyMarks.has(key)) {
            this.providerLatencyMarks.add(key);
            this.latency.mark(mark, detail);
          }
        } else {
          this.latency.markOnce(mark, detail);
        }
      }
      return;
    }

    const type = readString(event.type) ?? '';
    const loweredType = type.toLowerCase();
    const role = readString(event.role) ?? readString(event.speaker);
    const text = readString(event.text)
      ?? readString(event.transcript)
      ?? readString(event.deltaText)
      ?? readString(event.content);
    const isUserTranscript = role === 'user'
      && (type === 'transcript' || loweredType.includes('transcript') || loweredType.includes('asr'));
    if (isUserTranscript && text) {
      this.latency.markOnce('asr_first_text', {
        source: 'gateway',
        textChars: text.length,
      });
      const final = event.final === true || event.isFinal === true || loweredType.includes('final') || loweredType.includes('done');
      if (final) {
        this.latency.markOnce('asr_final', {
          source: 'gateway',
          textChars: text.length,
        });
      }
    }

    if (type === 'audio' && event.audioBase64) {
      const turnIndex = this.latestProviderTurnIndex;
      if (turnIndex !== undefined) {
        const key = `first_relay_audio_to_client:turn:${turnIndex}`;
        if (this.relayAudioLatencyMarks.has(key)) {
          return;
        }
        this.relayAudioLatencyMarks.add(key);
        this.latency.mark('first_relay_audio_to_client', {
          turnIndex,
          audioBase64Chars: String(event.audioBase64).length,
        });
        return;
      }
      this.latency.markOnce('first_relay_audio_to_client', {
        audioBase64Chars: String(event.audioBase64).length,
      });
    }
  }

  markToolLatencyOnce(callId, mark, detail) {
    const key = `${callId}:${mark}`;
    if (this.toolLatencyMarks.has(key)) {
      return undefined;
    }
    this.toolLatencyMarks.add(key);
    return this.latency.mark(mark, detail);
  }

  mirrorTelegramReply(text) {
    const replyText = normalizeRunText(text);
    if (!replyText) {
      return;
    }
    const call = this.runtime?.getCall?.(this.callId);
    const profile = call?.profile;
    if (!profile || readBoolean(profile.telegramMirrorReplies ?? this.runtime?.config?.telegramMirrorReplies) === false) {
      return;
    }

    const telegram = resolveTelegramDeliveryConfig({
      body: { chatId: call.chatId },
      profile,
      rootConfig: this.config,
      runtimeConfig: this.runtime?.config,
    });
    if (!telegram.config.botToken || telegram.config.chatId === undefined) {
      return;
    }

    Promise.resolve(this.telegramTextSender({
      config: telegram.config,
      env: telegram.env,
      text: replyText,
      call,
    })).catch((error) => {
      this.logger?.warn?.(`[doubao-telegram-call] Telegram reply mirror failed: ${errorMessage(error)}`);
    });
  }

  submitToolResult(callId, result, options) {
    if (this.completedToolCalls.has(callId)) {
      return Promise.resolve();
    }
    return this.gateway.request('talk.session.submitToolResult', {
      sessionId: this.relaySessionId,
      callId,
      result,
      ...(options ? { options } : {}),
    });
  }

  stop(options = {}) {
    if (this.closed) {
      return Promise.resolve();
    }
    this.closed = true;
    this.abortToolCalls();
    const shouldCloseGatewaySession = options.closeGatewaySession !== false && this.gateway && this.relaySessionId;
    const gateway = this.gateway;
    const closePromise = shouldCloseGatewaySession
      ? this.notifyAgentHangup().finally(() => gateway.request('talk.session.close', { sessionId: this.relaySessionId }).catch(() => undefined))
      : Promise.resolve();
    this.unsubscribeGateway?.();
    this.unsubscribeGateway = null;
    const closedPromise = closePromise.finally(() => {
      gateway?.close?.();
    });
    this.runtime?.closeCall?.(this.callId);
    if (options.closeSocket !== false) {
      closeSocket(this.socket);
    }
    return closedPromise;
  }

  async notifyAgentHangup() {
    if (this.agentHangupNotified || !this.gateway || !this.sessionKey || !this.relaySessionId || !this.callId) {
      return;
    }
    this.agentHangupNotified = true;
    await this.gateway.request('chat.send', {
      sessionKey: this.sessionKey,
      message: HANGUP_AGENT_MESSAGE,
      deliver: false,
      idempotencyKey: `telegram-call-hangup:${this.callId}`,
    }, { timeoutMs: HANGUP_AGENT_NOTIFY_TIMEOUT_MS }).catch((error) => {
      this.logger?.warn?.(`[doubao-telegram-call] Agent hangup notification failed: ${errorMessage(error)}`);
    });
  }

  abortToolCalls() {
    for (const controller of this.toolAbortControllers.values()) {
      controller.abort();
    }
    for (const runId of this.toolRunIds.values()) {
      this.gateway?.request?.('chat.abort', {
        runId,
        sessionKey: this.sessionKey,
      }).catch(() => undefined);
    }
    this.toolAbortControllers.clear();
    this.toolRunIds.clear();
  }

  sendState(state, detail) {
    sendJson(this.socket, {
      type: 'state',
      state,
      ...(detail ? { detail } : {}),
    });
  }

  sendSession(payload) {
    sendJson(this.socket, {
      type: 'session',
      ...payload,
    });
  }

  sendError(code, message) {
    sendJson(this.socket, {
      type: 'error',
      code,
      message,
    });
  }
}

export function parseRelayRequestUrl(url = '') {
  const parsed = new URL(url || '/', 'http://localhost');
  return {
    callId: readString(parsed.searchParams.get('callId')),
    token: readString(parsed.searchParams.get('token')),
    profileId: readString(parsed.searchParams.get('profile')) ?? readString(parsed.searchParams.get('profileId')),
  };
}

export function waitForAgentRunText({
  client,
  runId,
  timeoutMs = DEFAULT_TOOL_TIMEOUT_MS,
  signal,
  onText,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    let fallbackTimer;
    let latestText = '';
    let accumulatedDeltaText = '';
    const timer = setTimeout(() => {
      finish(reject, new Error('OpenClaw tool call timed out'));
    }, timeoutMs);
    timer.unref?.();
    const unsubscribe = client.addEventListener((frame) => {
      if (frame.event !== 'chat' || frame.payload?.runId !== runId) {
        return;
      }
      const payload = frame.payload;
      if (payload.stream === 'tool') {
        return;
      }
      if (payload.state === 'final') {
        const text = extractMessageText(payload.message) || latestText;
        if (text) {
          publishText(text, payload);
          finish(resolve, text);
          return;
        }
        fallbackTimer = setTimeout(() => {
          finish(resolve, 'OpenClaw finished with no text.');
        }, 500);
        fallbackTimer.unref?.();
      } else if (payload.state === 'aborted') {
        finish(reject, abortError(payload.errorMessage ?? 'OpenClaw tool call aborted'));
      } else if (payload.state === 'error') {
        finish(reject, new Error(payload.errorMessage ?? 'OpenClaw tool call failed'));
      } else {
        const text = extractLiveText(payload);
        if (text) {
          publishText(text, payload);
        }
      }
    });
    const abortListener = () => finish(reject, abortError());
    signal?.addEventListener('abort', abortListener, { once: true });

    function finish(handler, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(fallbackTimer);
      signal?.removeEventListener('abort', abortListener);
      unsubscribe();
      handler(value);
    }

    function publishText(text, payload) {
      const normalized = normalizeRunText(text);
      if (!normalized || normalized === latestText) {
        return;
      }
      latestText = normalized;
      onText?.(normalized, payload);
    }

    function extractLiveText(payload) {
      const messageText = extractMessageText(payload.message);
      if (messageText) {
        return messageText;
      }
      const directText = readString(payload.text) ?? readString(payload.content);
      if (directText) {
        return directText;
      }
      const deltaText = readString(payload.deltaText);
      if (deltaText) {
        accumulatedDeltaText += deltaText;
        return accumulatedDeltaText;
      }
      return '';
    }
  });
}

class AgentSpeechStreamer {
  constructor({ submitChunk }) {
    this.submitChunk = submitChunk;
    this.streamedPrefix = '';
    this.pending = Promise.resolve();
  }

  offer(text) {
    const current = normalizeRunText(text);
    if (!current || !current.startsWith(this.streamedPrefix)) {
      return;
    }
    const rawChunk = current.slice(this.streamedPrefix.length);
    const chunk = rawChunk.trim();
    this.streamedPrefix = current;
    if (chunk) {
      this.pending = this.pending.then(() => this.submitChunk(chunk));
    }
  }

  async finish(finalText) {
    const final = normalizeRunText(finalText);
    if (!final) {
      await this.pending;
      return '';
    }
    this.offer(final);
    await this.pending;
    return final.startsWith(this.streamedPrefix)
      ? final.slice(this.streamedPrefix.length).trim()
      : final;
  }
}

function normalizeToolArgs(args) {
  if (typeof args !== 'string') {
    return args ?? {};
  }
  try {
    return JSON.parse(args);
  } catch {
    return { question: args };
  }
}

function appendProfileInstructions(args, instructions) {
  const profileInstructions = readString(instructions);
  if (!profileInstructions) {
    return args;
  }
  const record = isRecord(args) ? { ...args } : {};
  const context = readString(record.context);
  return {
    ...record,
    context: context
      ? `${context}\n${profileInstructions}`
      : profileInstructions,
  };
}

function readEmotionTag(args) {
  const context = readString(args?.context);
  if (!context) {
    return undefined;
  }
  const match = context.match(/情绪\s*[:：]\s*([^\s。,.，；;]+)/);
  return match?.[1]?.trim() || undefined;
}

function normalizeControlArgs(args) {
  const normalized = normalizeToolArgs(args);
  const record = normalized && typeof normalized === 'object' && !Array.isArray(normalized)
    ? normalized
    : {};
  const text = readString(record.text) ?? readString(record.message) ?? readString(record.request) ?? readString(record.query);
  if (!text) {
    throw new Error('Control tool requires text');
  }
  const mode = ['status', 'steer', 'cancel', 'followup'].includes(record.mode)
    ? record.mode
    : undefined;
  return { text, mode };
}

function extractMessageText(message) {
  if (!message || typeof message !== 'object') {
    return '';
  }
  if (typeof message.text === 'string') {
    return message.text.trim();
  }
  return (Array.isArray(message.content) ? message.content : [])
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return '';
      }
      return part.type === 'text' && typeof part.text === 'string'
        ? part.text
        : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function sendJson(socket, payload) {
  if (!socket || socket.readyState === 3) {
    return;
  }
  socket.send(JSON.stringify({
    protocol: RELAY_PROTOCOL,
    ...payload,
  }));
}

function closeSocket(socket) {
  if (!socket || socket.readyState === 3) {
    return;
  }
  socket.close(1000, 'telegram-call-closed');
}

function addSocketListener(socket, event, listener) {
  socket.on(event, listener);
}

function parseJsonFrame(data) {
  try {
    if (typeof data === 'string') {
      return JSON.parse(data);
    }
    if (Buffer.isBuffer(data)) {
      return JSON.parse(data.toString('utf8'));
    }
    return JSON.parse(Buffer.from(data).toString('utf8'));
  } catch {
    return undefined;
  }
}

function abortError(message = 'OpenClaw tool call aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRunText(value) {
  if (typeof value !== 'string') {
    return '';
  }
  return value.trim();
}

function readFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
