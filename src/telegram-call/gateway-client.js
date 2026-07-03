import { WebSocket } from 'ws';

import {
  compactObject,
  readString,
} from '../values.js';

const DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_GATEWAY_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_GATEWAY_PORT = 18789;

export function createGatewayRpcSocket(options = {}) {
  return new GatewayRpcSocket(options);
}

export class GatewayRpcSocket {
  constructor(options = {}) {
    this.url = options.url ?? resolveGatewayWsUrl(options.config);
    this.auth = options.auth ?? resolveGatewayAuth(options.config);
    this.WebSocketCtor = options.WebSocketCtor ?? WebSocket;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_GATEWAY_REQUEST_TIMEOUT_MS;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_GATEWAY_CONNECT_TIMEOUT_MS;
    this.clientVersion = options.clientVersion;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.pending = new Map();
    this.listeners = new Set();
    this.nextId = 1;
    this.ws = null;
    this.connected = false;
    this.closed = false;
    this.connectPromise = null;
    this.connectSent = false;
  }

  addEventListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  connect() {
    if (this.connected) {
      return Promise.resolve(this.hello ?? {});
    }
    if (this.connectPromise) {
      return this.connectPromise;
    }
    this.closed = false;
    this.connectPromise = new Promise((resolve, reject) => {
      let connectTimer;
      const failConnect = (error) => {
        clearTimeout(connectTimer);
        if (!this.connected) {
          reject(error);
        }
      };
      connectTimer = setTimeout(() => {
        failConnect(new Error('Gateway connect timed out'));
        this.close();
      }, this.connectTimeoutMs);
      const ws = new this.WebSocketCtor(this.url);
      this.ws = ws;
      addSocketListener(ws, 'open', () => {
        this.sendConnect();
      });
      addSocketListener(ws, 'message', (data) => {
        this.handleMessage(data, {
          resolve: (payload) => {
            clearTimeout(connectTimer);
            this.connected = true;
            this.hello = payload;
            resolve(payload);
          },
          reject: failConnect,
        });
      });
      addSocketListener(ws, 'error', () => {
        failConnect(new Error('Gateway WebSocket failed'));
      });
      addSocketListener(ws, 'close', () => {
        const error = new Error('Gateway WebSocket closed');
        this.connected = false;
        this.rejectAll(error);
        failConnect(error);
      });
    });
    return this.connectPromise;
  }

  request(method, params = {}, options = {}) {
    if (this.closed || !this.ws || this.ws.readyState !== socketOpenState(this.WebSocketCtor)) {
      return Promise.reject(new Error('Gateway WebSocket is not connected'));
    }
    const id = this.makeId(method);
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Gateway request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.sendFrame({ type: 'req', id, method, params });
    });
  }

  close() {
    this.closed = true;
    this.connected = false;
    this.connectPromise = null;
    this.connectSent = false;
    this.rejectAll(new Error('Gateway client closed'));
    if (this.ws && this.ws.readyState !== socketClosedState(this.WebSocketCtor)) {
      this.ws.close(1000, 'telegram-call-relay-closed');
    }
    this.ws = null;
  }

  handleMessage(data, connectHandlers = {}) {
    const frame = parseJsonFrame(data);
    if (!frame) {
      return;
    }
    if (frame.type === 'event' && frame.event === 'connect.challenge') {
      this.sendConnect();
      return;
    }
    if (frame.type === 'event') {
      this.emitEvent(frame);
      return;
    }
    if (frame.type !== 'res' || !frame.id) {
      return;
    }
    const pending = this.pending.get(frame.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    if (frame.ok === true) {
      pending.resolve(frame.payload ?? {});
      if (frame.id.startsWith('tc_connect_')) {
        connectHandlers.resolve?.(frame.payload ?? {});
      }
      return;
    }
    const error = frameError(frame.error);
    pending.reject(error);
    if (frame.id.startsWith('tc_connect_')) {
      connectHandlers.reject?.(error);
    }
  }

  sendConnect() {
    if (this.connectSent || this.closed || !this.ws || this.ws.readyState !== socketOpenState(this.WebSocketCtor)) {
      return;
    }
    this.connectSent = true;
    const id = this.makeId('connect');
    const timer = setTimeout(() => {
      this.pending.delete(id);
    }, this.requestTimeoutMs);
    timer.unref?.();
    this.pending.set(id, {
      timer,
      resolve: () => undefined,
      reject: () => undefined,
    });
    this.sendFrame({
      type: 'req',
      id,
      method: 'connect',
      params: buildBackendGatewayConnectParams({
        auth: this.auth,
        clientVersion: this.clientVersion,
      }),
    });
  }

  sendFrame(frame) {
    this.ws.send(JSON.stringify(frame));
  }

  emitEvent(frame) {
    this.onEvent(frame);
    for (const listener of this.listeners) {
      listener(frame);
    }
  }

  rejectAll(error) {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  makeId(method) {
    const safeMethod = String(method).replace(/[^a-z0-9_.-]/gi, '_');
    return `tc_${safeMethod}_${this.nextId++}`;
  }
}

export function buildBackendGatewayConnectParams(options = {}) {
  const auth = compactObject({
    token: readString(options.auth?.token),
    password: readString(options.auth?.password),
  });
  return compactObject({
    minProtocol: 4,
    maxProtocol: 4,
    client: {
      id: 'gateway-client',
      displayName: 'Telegram Call Relay',
      version: options.clientVersion ?? 'doubao-telegram-call/0.1.0',
      platform: 'node',
      mode: 'backend',
    },
    role: 'operator',
    scopes: ['operator.write'],
    auth: Object.keys(auth).length > 0 ? auth : undefined,
  });
}

export function resolveGatewayWsUrl(config = {}, env = process.env) {
  const explicit = readString(env.OPENCLAW_GATEWAY_URL) ?? readString(config.gateway?.remote?.url);
  if (explicit) {
    return explicit;
  }
  const envPort = parsePort(env.OPENCLAW_GATEWAY_PORT);
  const port = envPort ?? (Number.isInteger(config.gateway?.port) ? config.gateway.port : DEFAULT_GATEWAY_PORT);
  return `ws://127.0.0.1:${port}/`;
}

export function resolveGatewayAuth(config = {}, env = process.env) {
  return compactObject({
    token: readString(env.OPENCLAW_GATEWAY_TOKEN) ?? readString(config.gateway?.auth?.token),
    password: readString(env.OPENCLAW_GATEWAY_PASSWORD) ?? readString(config.gateway?.auth?.password),
  });
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

function frameError(error) {
  const err = new Error(error?.message ?? error?.code ?? 'Gateway request failed');
  if (error?.code) {
    err.code = error.code;
  }
  if (error?.details) {
    err.details = error.details;
  }
  return err;
}

function socketOpenState(WebSocketCtor) {
  return WebSocketCtor?.OPEN ?? 1;
}

function socketClosedState(WebSocketCtor) {
  return WebSocketCtor?.CLOSED ?? 3;
}

function parsePort(value) {
  const raw = readString(value);
  if (!raw) {
    return undefined;
  }
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}
