export function readString(value) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function readChatId(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return readString(value);
}

export function readBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
}

export function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function compactObject(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

export function compactRecord(record) {
  const compacted = compactObject(record);
  return Object.keys(compacted).length > 0 ? compacted : undefined;
}
