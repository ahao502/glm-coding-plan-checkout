import { BILLING, NEXT_RELEASE_AT, PLAN, STATUSES } from './constants.js';

export function checkoutReady({ checkoutUrl, orderId }) {
  const result = {
    status: STATUSES.CHECKOUT_READY,
    plan: PLAN,
    billing: BILLING,
    checkoutUrl
  };

  if (orderId) {
    result.orderId = String(orderId);
  }

  return result;
}

export function failure(status, extra = {}) {
  return {
    status,
    plan: PLAN,
    billing: BILLING,
    ...extra
  };
}

export function outOfStock(extra = {}) {
  return failure(STATUSES.OUT_OF_STOCK, {
    nextReleaseAt: NEXT_RELEASE_AT,
    ...extra
  });
}

export function printJson(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}
