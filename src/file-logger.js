import { mkdir, appendFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DEFAULT_LOG_DIR = join('.logs', 'glm-coding');

function localDatePart(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function compactUndefined(value) {
  if (!value || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(compactUndefined);
  }

  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = compactUndefined(item);
    }
  }
  return result;
}

export function createDailyJsonlLogger({
  now = () => new Date(),
  logDir = DEFAULT_LOG_DIR,
  sessionId = randomUUID()
} = {}) {
  async function write(entry = {}) {
    const time = now();
    const filePath = join(logDir, `${localDatePart(time)}.jsonl`);
    const payload = compactUndefined({
      time: time.toISOString(),
      sessionId,
      level: entry.level || 'info',
      eventType: entry.eventType || 'log',
      status: entry.status,
      attempts: entry.attempts,
      message: entry.message || '',
      data: entry.data || null
    });

    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  }

  return {
    sessionId,
    write
  };
}
