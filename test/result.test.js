import assert from 'node:assert/strict';
import test from 'node:test';
import { STATUSES } from '../src/constants.js';
import { checkoutReady, failure, outOfStock } from '../src/result.js';

test('formats checkout-ready JSON payload', () => {
  assert.deepEqual(checkoutReady({ checkoutUrl: 'https://bigmodel.cn/pay/abc', orderId: 'abc' }), {
    status: STATUSES.CHECKOUT_READY,
    plan: 'pro',
    billing: 'monthly_recurring',
    checkoutUrl: 'https://bigmodel.cn/pay/abc',
    orderId: 'abc'
  });
});

test('formats fixed failure statuses', () => {
  assert.deepEqual(failure(STATUSES.PLAN_NOT_FOUND), {
    status: STATUSES.PLAN_NOT_FOUND,
    plan: 'pro',
    billing: 'monthly_recurring'
  });

  assert.deepEqual(failure(STATUSES.BUTTON_NEVER_ENABLED, { attempts: 12 }), {
    status: STATUSES.BUTTON_NEVER_ENABLED,
    plan: 'pro',
    billing: 'monthly_recurring',
    attempts: 12
  });
});

test('formats out-of-stock with release time', () => {
  assert.deepEqual(outOfStock(), {
    status: STATUSES.OUT_OF_STOCK,
    plan: 'pro',
    billing: 'monthly_recurring',
    nextReleaseAt: '10:00 UTC+8'
  });
});
