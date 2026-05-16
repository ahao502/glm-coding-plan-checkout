import assert from 'node:assert/strict';
import test from 'node:test';
import { STATUSES } from '../src/constants.js';
import { checkoutReady, failure } from '../src/result.js';
import { DEFAULT_RETRY_INTERVAL_MS, nextCheckoutWindow, runScheduledCheckout } from '../src/scheduler.js';
import { formatDuration, formatLocalDateTime } from '../src/time.js';

function silentOutput() {
  return {
    write() {}
  };
}

function memoryLogger(entries = []) {
  return () => ({
    sessionId: 'test-session',
    write(entry) {
      entries.push(entry);
      return Promise.resolve();
    }
  });
}

test('passes the 10:00-10:15 window to a single long-lived runner', async () => {
  const current = new Date(2026, 0, 1, 9, 55, 0, 0);
  const calls = [];

  const result = await runScheduledCheckout({
    now: () => current,
    runCheckout: async (options) => {
      calls.push(options);
      return checkoutReady({ checkoutUrl: 'https://bigmodel.cn/pay/abc' });
    },
    output: silentOutput(),
    createLogger: memoryLogger()
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].startAt.getHours(), 10);
  assert.equal(calls[0].startAt.getMinutes(), 0);
  assert.equal(calls[0].stopAt.getHours(), 10);
  assert.equal(calls[0].stopAt.getMinutes(), 15);
  assert.equal(calls[0].plan, 'pro');
  assert.equal(calls[0].billing, 'monthly_recurring');
  assert.equal(calls[0].retryIntervalMs, DEFAULT_RETRY_INTERVAL_MS);
  assert.equal(result.status, STATUSES.CHECKOUT_READY);
});

test('uses today window when started before 10:15', () => {
  const beforeStart = nextCheckoutWindow(new Date(2026, 0, 1, 9, 55, 0, 0));
  assert.equal(formatLocalDateTime(beforeStart.startAt), '2026-01-01 10:00:00');
  assert.equal(formatLocalDateTime(beforeStart.stopAt), '2026-01-01 10:15:00');

  const duringWindow = nextCheckoutWindow(new Date(2026, 0, 1, 10, 2, 0, 0));
  assert.equal(formatLocalDateTime(duringWindow.startAt), '2026-01-01 10:00:00');
  assert.equal(formatLocalDateTime(duringWindow.stopAt), '2026-01-01 10:15:00');
});

test('uses tomorrow window when started at or after 10:15', () => {
  const afterWindow = nextCheckoutWindow(new Date(2026, 0, 1, 14, 50, 0, 0));
  assert.equal(formatLocalDateTime(afterWindow.startAt), '2026-01-02 10:00:00');
  assert.equal(formatLocalDateTime(afterWindow.stopAt), '2026-01-02 10:15:00');

  const exactStop = nextCheckoutWindow(new Date(2026, 0, 1, 10, 15, 0, 0));
  assert.equal(formatLocalDateTime(exactStop.startAt), '2026-01-02 10:00:00');
  assert.equal(formatLocalDateTime(exactStop.stopAt), '2026-01-02 10:15:00');
});

test('formats countdown durations as hours minutes and seconds', () => {
  assert.equal(formatDuration(5 * 60 * 1000), '0h 05m 00s');
  assert.equal(formatDuration(19 * 60 * 60 * 1000 + 8 * 60 * 1000 + 31 * 1000), '19h 08m 31s');
  assert.equal(formatDuration(1), '0h 00m 01s');
});

test('uses an explicit retry interval override', async () => {
  const current = new Date(2026, 0, 1, 9, 55, 0, 0);
  let receivedRetryIntervalMs;

  await runScheduledCheckout({
    now: () => current,
    runCheckout: async ({ retryIntervalMs }) => {
      receivedRetryIntervalMs = retryIntervalMs;
      return checkoutReady({ checkoutUrl: 'https://bigmodel.cn/pay/abc' });
    },
    output: silentOutput(),
    retryIntervalMs: 250,
    createLogger: memoryLogger()
  });

  assert.equal(receivedRetryIntervalMs, 250);
});

test('passes an explicit target plan and billing to the runner', async () => {
  const current = new Date(2026, 0, 1, 9, 55, 0, 0);
  let received;

  await runScheduledCheckout({
    now: () => current,
    runCheckout: async ({ plan, billing }) => {
      received = { plan, billing };
      return checkoutReady({ checkoutUrl: 'https://bigmodel.cn/pay/abc', plan, billing });
    },
    output: silentOutput(),
    plan: 'lite',
    billing: 'quarterly_recurring',
    createLogger: memoryLogger()
  });

  assert.deepEqual(received, {
    plan: 'lite',
    billing: 'quarterly_recurring'
  });
});

test('returns login-required failures from the long-lived runner', async () => {
  const current = new Date(2026, 0, 1, 10, 0, 0, 0);

  const result = await runScheduledCheckout({
    now: () => current,
    runCheckout: async () => failure(STATUSES.LOGIN_REQUIRED),
    output: silentOutput(),
    createLogger: memoryLogger()
  });

  assert.equal(result.status, STATUSES.LOGIN_REQUIRED);
});

test('scheduled checkout writes JSONL lifecycle events through logger', async () => {
  const current = new Date(2026, 4, 6, 9, 55, 0, 0);
  const entries = [];

  await runScheduledCheckout({
    now: () => current,
    runCheckout: async ({ onEvent }) => {
      onEvent({ type: 'attempt', attempts: 1 });
      onEvent({ type: 'result', result: checkoutReady({ checkoutUrl: 'https://bigmodel.cn/pay/abc' }) });
      return checkoutReady({ checkoutUrl: 'https://bigmodel.cn/pay/abc' });
    },
    output: silentOutput(),
    createLogger: memoryLogger(entries)
  });

  assert.deepEqual(entries.map((entry) => entry.eventType), [
    'task_started',
    'attempt',
    'result',
    'task_finished'
  ]);
  assert.equal(entries[2].data.checkoutUrl, 'https://bigmodel.cn/pay/abc');
});
