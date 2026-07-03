import {
  compactRecord,
  readString,
} from '../values.js';

const LOG_PREFIX = '[doubao-telegram-call/latency]';

export function createLatencyTracker(options = {}) {
  const logger = options.logger ?? console;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  let context = compactRecord({
    component: options.component,
    callId: options.callId,
    profileId: options.profileId,
    relaySessionId: options.relaySessionId,
    sessionKey: options.sessionKey,
  }) ?? {};
  let startedAtMs;
  let previousAtMs;
  const emitted = new Set();

  function setContext(next = {}) {
    context = compactRecord({
      ...context,
      component: next.component ?? context.component,
      callId: next.callId ?? context.callId,
      profileId: next.profileId ?? context.profileId,
      relaySessionId: next.relaySessionId ?? context.relaySessionId,
      sessionKey: next.sessionKey ?? context.sessionKey,
    }) ?? {};
  }

  function mark(name, detail = {}) {
    const markName = readString(name);
    if (!markName) {
      return undefined;
    }
    const atMs = readNumber(now()) ?? Date.now();
    if (startedAtMs === undefined) {
      startedAtMs = atMs;
    }
    const entry = compactRecord({
      ...context,
      mark: markName,
      atMs: Math.round(atMs),
      sinceStartMs: Math.max(0, Math.round(atMs - startedAtMs)),
      sincePreviousMs: previousAtMs === undefined ? 0 : Math.max(0, Math.round(atMs - previousAtMs)),
      ...sanitizeDetail(detail),
    });
    previousAtMs = atMs;
    writeLog(logger, entry);
    return entry;
  }

  function markOnce(name, detail = {}) {
    const markName = readString(name);
    if (!markName || emitted.has(markName)) {
      return undefined;
    }
    emitted.add(markName);
    return mark(markName, detail);
  }

  return {
    setContext,
    mark,
    markOnce,
  };
}

function writeLog(logger, entry) {
  const line = `${LOG_PREFIX} ${JSON.stringify(entry)}`;
  try {
    if (typeof logger?.warn === 'function') {
      logger.warn(line);
      return;
    }
    if (typeof logger?.log === 'function') {
      logger.log(line);
    }
  } catch {
    // Telemetry must never disturb a live call.
  }
}

function sanitizeDetail(detail = {}) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    return {};
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(detail)) {
    const safeKey = readString(key);
    if (!safeKey || /token|secret|key|authorization|password/i.test(safeKey)) {
      continue;
    }
    if (typeof value === 'string') {
      const text = value.trim();
      if (text) {
        sanitized[safeKey] = text.length > 160 ? text.slice(0, 160) : text;
      }
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      sanitized[safeKey] = Math.round(value);
    } else if (typeof value === 'boolean') {
      sanitized[safeKey] = value;
    }
  }
  return sanitized;
}

function readNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
