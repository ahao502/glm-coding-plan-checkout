import { join } from 'node:path';

export const GLM_CODING_URL = 'https://bigmodel.cn/glm-coding';
export const PLAN = 'pro';
export const BILLING = 'monthly_recurring';
export const NEXT_RELEASE_AT = '10:00 UTC+8';
export const STORAGE_STATE_PATH = join('.auth', 'glm-coding', 'storageState.json');

export const STATUSES = Object.freeze({
  CHECKOUT_READY: 'checkout_ready',
  LOGIN_REQUIRED: 'login_required',
  OUT_OF_STOCK: 'out_of_stock',
  PLAN_NOT_FOUND: 'plan_not_found',
  CHECKOUT_NOT_CREATED: 'checkout_not_created',
  CONTRACT_CHANGED: 'contract_changed'
});
