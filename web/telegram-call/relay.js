export const RELAY_PROTOCOL = 'openclaw.telegram-call.relay.v1';

const RELAY_ROUTE_PATH = '/plugins/doubao-telegram-call/telegram-call/relay';
const MAX_BUFFERED_AUDIO_BYTES = 128 * 1024;
const BARGE_IN_RMS_THRESHOLD = 0.02;
const BARGE_IN_PEAK_THRESHOLD = 0.08;
const DEFAULT_BARGE_IN_SPEECH_MS = 160;

export function createTelegramCallRelay(options = {}) {
  return new TelegramCallPluginRelay(options);
}

export class TelegramCallPluginRelay {
  constructor(options = {}) {
    this.bootstrap = options.bootstrap ?? {};
    this.callId = options.callId ?? this.bootstrap.call?.callId;
    this.token = options.token;
    this.profileId = options.profileId ?? this.bootstrap.call?.profileId;
    this.location = options.location ?? globalThis.location;
    this.WebSocketCtor = options.WebSocketCtor ?? globalThis.WebSocket;
    this.AudioContextCtor = options.AudioContextCtor ?? globalThis.AudioContext ?? globalThis.webkitAudioContext;
    this.outputQueue = options.outputQueue ?? new PcmOutputQueue();
    this.maxBufferedAudioBytes = options.maxBufferedAudioBytes ?? MAX_BUFFERED_AUDIO_BYTES;
    this.onStatus = options.onStatus ?? (() => undefined);
    this.onTranscript = options.onTranscript ?? (() => undefined);
    this.onTalkEvent = options.onTalkEvent ?? (() => undefined);
    this.onPlaybackStart = options.onPlaybackStart ?? (() => undefined);
    this.onError = options.onError ?? (() => undefined);
    this.socket = null;
    this.outputContext = null;
    this.session = null;
    this.relaySessionId = null;
    this.audio = this.bootstrap.pluginRelay?.audio ?? this.bootstrap.gatewayRelay?.audio ?? {};
    this.closed = false;
    this.droppedAudioFrames = 0;
    this.speechMsDuringPlayback = 0;
    this.bargeInSpeechMs = readPositiveNumber(options.bargeInSpeechMs) ?? DEFAULT_BARGE_IN_SPEECH_MS;
    this.cancelRequestedForPlayback = false;
    this.playbackStarted = false;
    this.startResolve = null;
    this.startReject = null;
  }

  start() {
    if (this.session) {
      return Promise.resolve(this.session);
    }
    if (!this.bootstrap.pluginRelay?.url) {
      return Promise.reject(new Error('Missing plugin relay bootstrap'));
    }
    if (!this.WebSocketCtor) {
      return Promise.reject(new Error('WebSocket is not available in this browser'));
    }
    if (!this.AudioContextCtor) {
      return Promise.reject(new Error('AudioContext is not available in this browser'));
    }

    this.closed = false;
    this.onStatus('relay_connecting', 'Connecting');
    const url = buildRelayWebSocketUrl(this.location, {
      relayUrl: this.bootstrap.pluginRelay.url,
      callId: this.callId,
      token: this.token,
      profileId: this.profileId,
    });
    this.socket = new this.WebSocketCtor(url);
    addSocketListener(this.socket, 'open', () => {
      this.onStatus('relay_connected', 'Connected');
    });
    addSocketListener(this.socket, 'message', (event) => {
      this.handleSocketMessage(event.data ?? event);
    });
    addSocketListener(this.socket, 'error', () => {
      this.failStart(new Error('Plugin relay WebSocket failed'));
    });
    addSocketListener(this.socket, 'close', (event = {}) => {
      const reason = event.reason || `code=${event.code ?? 'unknown'}`;
      if (!this.closed && !this.session) {
        this.failStart(new Error(`Plugin relay WebSocket closed: ${reason}`));
      }
      this.closed = true;
    });

    return new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
  }

  async stop(options = {}) {
    if (this.closed && !this.socket) {
      return;
    }
    this.closed = true;
    this.stopOutput();
    if (options.sendHangup !== false) {
      this.sendFrame({ type: 'hangup' });
    }
    await this.outputContext?.close?.();
    this.outputContext = null;
    this.closeSocket();
    this.onStatus('closed', 'Closed');
  }

  appendAudioFrame(frame = {}) {
    if (this.closed || !this.relaySessionId || !frame.pcm16 || !this.isSocketOpen()) {
      return;
    }
    if ((this.socket.bufferedAmount ?? 0) > this.maxBufferedAudioBytes) {
      this.droppedAudioFrames += 1;
      return;
    }
    if (this.detectBargeIn(frame.pcm16)) {
      this.cancelOutputForBargeIn();
    }
    this.sendFrame({
      type: 'audio',
      audioBase64: base64FromArrayBuffer(frame.pcm16),
      timestamp: Math.round(Number.isFinite(frame.timestamp) ? frame.timestamp : performance.now()),
    });
  }

  appendAudio(frame = {}) {
    this.appendAudioFrame(frame);
  }

  handleSocketMessage(data) {
    const message = parseJsonFrame(data);
    if (!message || message.protocol !== RELAY_PROTOCOL) {
      return;
    }

    switch (message.type) {
      case 'state':
        this.onStatus(message.state ?? 'relay_state', message.detail);
        return;
      case 'session':
        void this.acceptSession(message).catch((error) => {
          this.failStart(error);
          this.handleError(error);
        });
        return;
      case 'relayEvent':
        this.handleRelayEvent(message.event);
        return;
      case 'error': {
        const messageText = message.message ?? message.code ?? 'Plugin relay failed';
        if (isRecoverableRelayError(messageText)) {
          this.onStatus('tool_call_aborted', messageText);
          return;
        }
        const error = new Error(messageText);
        error.code = message.code;
        this.handleError(error);
        if (!this.session) {
          this.failStart(error);
        }
        return;
      }
      default:
    }
  }

  async acceptSession(message) {
    const session = message.session ?? {};
    const relaySessionId = session.relaySessionId ?? session.sessionId;
    if (!relaySessionId) {
      throw new Error('Plugin relay did not return a session id');
    }

    this.session = session;
    this.relaySessionId = relaySessionId;
    this.audio = message.audio ?? session.audio ?? this.bootstrap.pluginRelay?.audio ?? {};
    const outputSampleRateHz = this.audio.outputSampleRateHz ?? 24_000;
    this.outputContext = new this.AudioContextCtor({
      latencyHint: 'interactive',
    });
    await this.outputContext.resume?.();
    this.onStatus('relay_ready', 'Ready');
    this.startResolve?.(session);
    this.startResolve = null;
    this.startReject = null;
  }

  handleRelayEvent(event = {}) {
    if (!event || this.closed) {
      return;
    }
    if (event.relaySessionId && this.relaySessionId && event.relaySessionId !== this.relaySessionId) {
      return;
    }
    if (event.talkEvent) {
      this.onTalkEvent(event.talkEvent);
    }

    switch (event.type) {
      case 'ready':
        this.onStatus('listening', 'Listening');
        return;
      case 'audio':
        if (event.audioBase64) {
          this.cancelRequestedForPlayback = false;
          this.speechMsDuringPlayback = 0;
          this.playPcm16(event.audioBase64);
          this.reportPlaybackStartOnce();
          this.onStatus('speaking', 'Speaking');
        }
        return;
      case 'clear':
        this.stopOutput();
        return;
      case 'transcript':
        if (event.role && event.text) {
          this.onTranscript({
            role: event.role,
            text: event.text,
            final: event.final ?? false,
          });
        }
        return;
      case 'error':
        this.handleRelayError(event.message ?? 'Realtime relay failed');
        return;
      case 'close':
        this.onStatus(event.reason === 'error' ? 'error' : 'closed', event.reason ?? 'Closed');
        void this.stop({ sendHangup: false });
        return;
      default:
    }
  }

  playPcm16(audioBase64) {
    this.outputQueue.play(audioBase64, this.outputContext, this.audio.outputSampleRateHz ?? 24_000);
  }

  reportPlaybackStartOnce() {
    if (this.playbackStarted) {
      return;
    }
    this.playbackStarted = true;
    this.onPlaybackStart({
      callId: this.callId,
      profileId: this.profileId,
      relaySessionId: this.relaySessionId,
    });
  }

  stopOutput() {
    this.outputQueue.stop(this.outputContext);
    this.speechMsDuringPlayback = 0;
  }

  detectBargeIn(pcm16) {
    if (!this.outputQueue.isPlaying || this.cancelRequestedForPlayback) {
      this.speechMsDuringPlayback = 0;
      return false;
    }
    const detection = detectSpeechFromPcm16(pcm16);
    const frameMs = readPositiveNumber(this.audio.inputFrameMs) ?? 20;
    this.speechMsDuringPlayback = detection.speech
      ? this.speechMsDuringPlayback + frameMs
      : 0;
    return this.speechMsDuringPlayback >= this.bargeInSpeechMs;
  }

  cancelOutputForBargeIn() {
    if (this.cancelRequestedForPlayback || !this.relaySessionId) {
      return;
    }
    this.cancelRequestedForPlayback = true;
    this.stopOutput();
    this.sendFrame({
      type: 'cancelOutput',
      reason: 'barge-in',
    });
  }

  handleError(error) {
    this.onStatus('error', errorMessage(error));
    this.onError(error);
  }

  handleRelayError(message) {
    if (isRecoverableRelayError(message)) {
      this.onStatus('tool_call_aborted', message);
      return;
    }
    this.handleError(new Error(message));
  }

  failStart(error) {
    if (this.startReject) {
      this.startReject(error);
      this.startResolve = null;
      this.startReject = null;
    }
  }

  sendFrame(payload) {
    if (!this.isSocketOpen()) {
      return false;
    }
    this.socket.send(JSON.stringify({
      protocol: RELAY_PROTOCOL,
      ...payload,
    }));
    return true;
  }

  isSocketOpen() {
    return this.socket?.readyState === (this.WebSocketCtor?.OPEN ?? 1);
  }

  closeSocket() {
    const socket = this.socket;
    this.socket = null;
    if (!socket || socket.readyState === (this.WebSocketCtor?.CLOSED ?? 3)) {
      return;
    }
    socket.close(1000, 'telegram-call-closed');
  }
}

export class TelegramCallRelay extends TelegramCallPluginRelay {}

export class PcmOutputQueue {
  constructor() {
    this.playhead = 0;
    this.sources = new Set();
  }

  get queuedUntil() {
    return this.playhead;
  }

  get isPlaying() {
    return this.sources.size > 0;
  }

  play(audioBase64, audioContext, sampleRateHz) {
    if (!audioContext || !audioBase64) {
      return;
    }
    const floats = pcm16Base64ToFloat32(audioBase64);
    if (floats.length === 0) {
      return;
    }
    const buffer = audioContext.createBuffer(1, floats.length, sampleRateHz);
    buffer.getChannelData(0).set(floats);
    const source = audioContext.createBufferSource();
    this.sources.add(source);
    source.addEventListener('ended', () => this.sources.delete(source));
    source.buffer = buffer;
    source.connect(audioContext.destination);
    const startAt = Math.max(audioContext.currentTime, this.playhead);
    source.start(startAt);
    this.playhead = startAt + buffer.duration;
  }

  stop(audioContext) {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // Source may have ended between iteration and stop.
      }
    }
    this.sources.clear();
    this.playhead = audioContext?.currentTime ?? 0;
  }
}

export function buildRelayWebSocketUrl(locationLike = globalThis.location, params = {}) {
  const locationUrl = normalizeLocationUrl(locationLike);
  const pageProtocol = locationUrl.protocol === 'https:' || locationUrl.protocol === 'wss:' ? 'wss:' : 'ws:';
  const origin = `${pageProtocol}//${locationUrl.host || '127.0.0.1:18789'}`;
  const relayUrl = readString(params.relayUrl) ?? readString(params.bootstrap?.pluginRelay?.url) ?? RELAY_ROUTE_PATH;
  const url = new URL(relayUrl, origin);

  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  }

  if (params.callId) {
    url.searchParams.set('callId', params.callId);
  }
  if (params.token) {
    url.searchParams.set('token', params.token);
  }
  if (params.profileId) {
    url.searchParams.set('profile', params.profileId);
  }
  return url.toString();
}

export function base64FromArrayBuffer(buffer) {
  const bytes = buffer instanceof Uint8Array
    ? buffer
    : new Uint8Array(buffer);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

export function uint8ArrayFromBase64(base64) {
  if (!base64) {
    return new Uint8Array();
  }
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function pcm16Base64ToFloat32(base64) {
  return pcm16BytesToFloat32(uint8ArrayFromBase64(base64));
}

export function pcm16BytesToFloat32(bytes) {
  const view = bytes instanceof Int16Array
    ? bytes
    : new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const floats = new Float32Array(view.length);
  for (let index = 0; index < view.length; index += 1) {
    floats[index] = view[index] / 32768;
  }
  return floats;
}

export function detectSpeechFromPcm16(pcm16, options = {}) {
  const view = pcm16 instanceof Int16Array
    ? pcm16
    : new Int16Array(pcm16.buffer ?? pcm16, pcm16.byteOffset ?? 0, Math.floor((pcm16.byteLength ?? pcm16.length) / 2));
  if (view.length === 0) {
    return { speech: false, rms: 0, peak: 0 };
  }

  let peak = 0;
  let sumSquares = 0;
  for (let index = 0; index < view.length; index += 1) {
    const value = Math.abs(view[index] / 32768);
    peak = Math.max(peak, value);
    sumSquares += value * value;
  }
  const rms = Math.sqrt(sumSquares / view.length);
  const speech = rms >= (options.rmsThreshold ?? BARGE_IN_RMS_THRESHOLD)
    && peak >= (options.peakThreshold ?? BARGE_IN_PEAK_THRESHOLD);
  return { speech, rms, peak };
}

function normalizeLocationUrl(locationLike) {
  if (typeof locationLike === 'string') {
    return new URL(locationLike, 'http://127.0.0.1:18789/');
  }
  if (locationLike?.href) {
    return new URL(locationLike.href);
  }
  const protocol = locationLike?.protocol ?? 'http:';
  const host = locationLike?.host ?? '127.0.0.1:18789';
  return new URL(`${protocol}//${host}/`);
}

function addSocketListener(socket, event, listener) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(event, listener);
    return;
  }
  if (typeof socket.on === 'function') {
    socket.on(event, listener);
    return;
  }
  socket[`on${event}`] = listener;
}

function parseJsonFrame(data) {
  try {
    if (typeof data === 'string') {
      return JSON.parse(data);
    }
    if (data instanceof ArrayBuffer) {
      return JSON.parse(new TextDecoder().decode(new Uint8Array(data)));
    }
    if (ArrayBuffer.isView(data)) {
      return JSON.parse(new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)));
    }
    return JSON.parse(String(data));
  } catch {
    return undefined;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRecoverableRelayError(message) {
  return /OpenClaw tool call aborted/i.test(String(message ?? ''));
}

function readString(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function readPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}
