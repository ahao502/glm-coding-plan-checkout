import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createDailyJsonlLogger } from '../src/file-logger.js';

test('daily JSONL logger creates and appends entries for the same day', async () => {
  const logDir = await mkdtemp(join(tmpdir(), 'glm-logs-'));
  const now = () => new Date('2026-05-06T12:00:00.000Z');
  const logger = createDailyJsonlLogger({ now, logDir, sessionId: 'session-1' });

  await logger.write({ eventType: 'task_started', message: 'started' });
  await logger.write({ eventType: 'attempt', attempts: 2, data: { url: 'https://bigmodel.cn/api/order/create' } });

  const content = await readFile(join(logDir, '2026-05-06.jsonl'), 'utf8');
  const lines = content.trim().split('\n').map((line) => JSON.parse(line));

  assert.equal(lines.length, 2);
  assert.equal(lines[0].sessionId, 'session-1');
  assert.equal(lines[0].eventType, 'task_started');
  assert.equal(lines[1].eventType, 'attempt');
  assert.equal(lines[1].attempts, 2);
  assert.equal(lines[1].data.url, 'https://bigmodel.cn/api/order/create');
});

test('daily JSONL logger rolls over by local day', async () => {
  const logDir = await mkdtemp(join(tmpdir(), 'glm-logs-'));
  const dates = [
    new Date(2026, 4, 6, 23, 59, 59),
    new Date(2026, 4, 7, 0, 0, 0)
  ];
  const logger = createDailyJsonlLogger({ now: () => dates.shift(), logDir, sessionId: 'session-2' });

  await logger.write({ eventType: 'before_midnight' });
  await logger.write({ eventType: 'after_midnight' });

  const first = await readFile(join(logDir, '2026-05-06.jsonl'), 'utf8');
  const second = await readFile(join(logDir, '2026-05-07.jsonl'), 'utf8');

  assert.equal(JSON.parse(first).eventType, 'before_midnight');
  assert.equal(JSON.parse(second).eventType, 'after_midnight');
});
