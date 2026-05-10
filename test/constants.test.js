import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BILLING_OPTIONS,
  normalizeBilling,
  normalizePlan,
  PLAN_OPTIONS,
  billingLabel,
  planLabel
} from '../src/constants.js';

test('exposes the selectable GLM Coding plans and billing cycles', () => {
  assert.deepEqual(PLAN_OPTIONS.map((option) => option.value), ['lite', 'pro', 'max']);
  assert.deepEqual(BILLING_OPTIONS.map((option) => option.value), [
    'monthly_recurring',
    'quarterly_recurring',
    'yearly_recurring'
  ]);
});

test('normalizes and labels valid plan and billing values', () => {
  assert.equal(normalizePlan('Pro'), 'pro');
  assert.equal(normalizeBilling('quarterly_recurring'), 'quarterly_recurring');
  assert.equal(planLabel('max'), 'Max');
  assert.equal(billingLabel('yearly_recurring'), '连续包年');
});

test('rejects invalid plan and billing values', () => {
  assert.throws(() => normalizePlan('team'), /Invalid plan/);
  assert.throws(() => normalizeBilling('one_time'), /Invalid billing/);
});
