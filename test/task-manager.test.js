import assert from 'node:assert/strict';
import test from 'node:test';
import { CheckoutTaskManager, defaultStartAt, stopAtForStart } from '../src/task-manager.js';

function memoryLogger(entries = []) {
  return () => ({
    sessionId: 'test-session',
    write(entry) {
      entries.push(entry);
      return Promise.resolve();
    }
  });
}

test('computes default start time as the next 10:00 window', () => {
  assert.equal(defaultStartAt(new Date(2026, 0, 1, 9, 55)).toISOString(), new Date(2026, 0, 1, 10, 0).toISOString());
  assert.equal(defaultStartAt(new Date(2026, 0, 1, 14, 50)).toISOString(), new Date(2026, 0, 2, 10, 0).toISOString());
});

test('sets stop time to five minutes after start', () => {
  const startAt = new Date(2026, 0, 1, 10, 0);
  assert.equal(stopAtForStart(startAt).toISOString(), new Date(2026, 0, 1, 10, 5).toISOString());
});

test('rejects a second concurrent checkout task', async () => {
  let release;
  const manager = new CheckoutTaskManager({
    createLogger: memoryLogger(),
    runCheckout: () =>
      new Promise((resolve) => {
        release = () => resolve({ status: 'checkout_ready', attempts: 1 });
      })
  });

  const first = manager.start({ startAt: new Date(2026, 0, 1, 10, 0), retryIntervalMs: 500 });
  assert.throws(
    () => manager.start({ startAt: new Date(2026, 0, 1, 10, 0), retryIntervalMs: 500 }),
    /already running/
  );

  release();
  await first;
});

test('stop aborts the running checkout task', async () => {
  const manager = new CheckoutTaskManager({
    createLogger: memoryLogger(),
    runCheckout: ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      })
  });

  const running = manager.start({ startAt: new Date(2026, 0, 1, 10, 0), retryIntervalMs: 500 });
  assert.equal(manager.stop(), true);

  const result = await running;
  assert.equal(result.status, 'stopped');
  assert.equal(manager.getStatus().status, 'stopped');
});

test('status includes running task fields and latest result', async () => {
  const manager = new CheckoutTaskManager({
    now: () => new Date(2026, 0, 1, 9, 59, 30),
    createLogger: memoryLogger(),
    runCheckout: async ({ onEvent }) => {
      onEvent({ type: 'countdown', timeRemainingMs: 30_000 });
      onEvent({ type: 'attempt', attempts: 2 });
      return { status: 'checkout_ready', attempts: 2, checkoutUrl: 'https://bigmodel.cn/pay/abc' };
    }
  });

  const result = await manager.start({
    startAt: new Date(2026, 0, 1, 10, 0),
    plan: 'max',
    billing: 'yearly_recurring',
    retryIntervalMs: 250
  });
  const status = manager.getStatus();

  assert.equal(result.status, 'checkout_ready');
  assert.equal(status.running, false);
  assert.equal(status.status, 'success');
  assert.equal(status.attempts, 2);
  assert.equal(status.plan, 'max');
  assert.equal(status.billing, 'yearly_recurring');
  assert.equal(status.retryIntervalMs, 250);
  assert.equal(status.lastResult.checkoutUrl, 'https://bigmodel.cn/pay/abc');
});

test('writes task lifecycle and checkout events to logger', async () => {
  const entries = [];
  const manager = new CheckoutTaskManager({
    now: () => new Date(2026, 4, 6, 9, 59, 30),
    createLogger: memoryLogger(entries),
    runCheckout: async ({ onEvent }) => {
      onEvent({ type: 'attempt', attempts: 1 });
      onEvent({ type: 'log', message: '解析到灰色按钮入口: POST https://bigmodel.cn/api/order/create', level: 'info' });
      onEvent({ type: 'result', result: { status: 'checkout_ready', checkoutUrl: 'https://bigmodel.cn/pay/abc' } });
      return { status: 'checkout_ready', attempts: 1, checkoutUrl: 'https://bigmodel.cn/pay/abc' };
    }
  });

  await manager.start({
    startAt: new Date(2026, 4, 6, 10, 0),
    plan: 'lite',
    billing: 'quarterly_recurring',
    retryIntervalMs: 500
  });

  assert.deepEqual(entries.map((entry) => entry.eventType), [
    'task_started',
    'attempt',
    'log',
    'result',
    'task_finished'
  ]);
  assert.equal(entries[2].message, '解析到灰色按钮入口: POST https://bigmodel.cn/api/order/create');
  assert.equal(entries[0].data.plan, 'lite');
  assert.equal(entries[0].data.billing, 'quarterly_recurring');
  assert.equal(entries[4].data.checkoutUrl, 'https://bigmodel.cn/pay/abc');
});

test('writes stopped task event to logger', async () => {
  const entries = [];
  const manager = new CheckoutTaskManager({
    createLogger: memoryLogger(entries),
    runCheckout: ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true }
        );
      })
  });

  const running = manager.start({ startAt: new Date(2026, 4, 6, 10, 0), retryIntervalMs: 500 });
  manager.stop();
  await running;

  assert.equal(entries.at(-1).eventType, 'task_stopped');
});
