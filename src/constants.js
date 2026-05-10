import { join } from 'node:path';

export const GLM_CODING_URL = 'https://bigmodel.cn/glm-coding';
export const PLAN_OPTIONS = Object.freeze([
  { value: 'lite', label: 'Lite' },
  { value: 'pro', label: 'Pro' },
  { value: 'max', label: 'Max' }
]);
export const BILLING_OPTIONS = Object.freeze([
  { value: 'monthly_recurring', label: '连续包月', shortLabel: '包月' },
  { value: 'quarterly_recurring', label: '连续包季', shortLabel: '包季' },
  { value: 'yearly_recurring', label: '连续包年', shortLabel: '包年' }
]);
export const PLAN = 'pro';
export const BILLING = 'monthly_recurring';
export const NEXT_RELEASE_AT = '10:00 UTC+8';
export const STORAGE_STATE_PATH = join('.auth', 'glm-coding', 'storageState.json');

export function normalizePlan(value = PLAN) {
  const normalized = String(value || '').trim().toLowerCase();
  const found = PLAN_OPTIONS.find((option) => option.value === normalized);
  if (!found) {
    const error = new Error(`Invalid plan: ${value}`);
    error.code = 'INVALID_PLAN';
    throw error;
  }
  return found.value;
}

export function normalizeBilling(value = BILLING) {
  const normalized = String(value || '').trim().toLowerCase();
  const found = BILLING_OPTIONS.find((option) => option.value === normalized);
  if (!found) {
    const error = new Error(`Invalid billing: ${value}`);
    error.code = 'INVALID_BILLING';
    throw error;
  }
  return found.value;
}

export function planLabel(plan = PLAN) {
  return PLAN_OPTIONS.find((option) => option.value === normalizePlan(plan)).label;
}

export function billingLabel(billing = BILLING) {
  return BILLING_OPTIONS.find((option) => option.value === normalizeBilling(billing)).label;
}

export const STATUSES = Object.freeze({
  CHECKOUT_READY: 'checkout_ready',
  BUSY_RETRYABLE: 'busy_retryable',
  LOGIN_REQUIRED: 'login_required',
  OUT_OF_STOCK: 'out_of_stock',
  PLAN_NOT_FOUND: 'plan_not_found',
  BUTTON_NEVER_ENABLED: 'button_never_enabled',
  CHECKOUT_NOT_CREATED: 'checkout_not_created',
  CONTRACT_CHANGED: 'contract_changed'
});
