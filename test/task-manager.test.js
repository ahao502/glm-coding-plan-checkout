import assert from 'node:assert/strict';
import test from 'node:test';
import { CheckoutTaskManager, defaultStartAt, stopAtForStart } from '../src/task-manager.js';

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
    runCheckout: async ({ onEvent }) => {
      onEvent({ type: 'countdown', timeRemainingMs: 30_000 });
      onEvent({ type: 'attempt', attempts: 2 });
      return { status: 'checkout_ready', attempts: 2, checkoutUrl: 'https://bigmodel.cn/pay/abc' };
    }
  });

  const result = await manager.start({ startAt: new Date(2026, 0, 1, 10, 0), retryIntervalMs: 250 });
  const status = manager.getStatus();

  assert.equal(result.status, 'checkout_ready');
  assert.equal(status.running, false);
  assert.equal(status.status, 'success');
  assert.equal(status.attempts, 2);
  assert.equal(status.retryIntervalMs, 250);
  assert.equal(status.lastResult.checkoutUrl, 'https://bigmodel.cn/pay/abc');
});
