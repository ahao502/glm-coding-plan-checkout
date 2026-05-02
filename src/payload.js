import { absolutizeUrl, looksLikeCheckoutUrl } from './url.js';

const ORDER_ID_KEYS = /(^|_)(order|trade|purchase)(_|-)?id$/i;
const OUT_OF_STOCK_RE = /(库存不足|售罄|暂无库存|已抢光|sold\s*out|out\s*of\s*stock|not\s*available)/i;
const LOGIN_REQUIRED_RE = /(登录|登陆|login|unauthorized|未授权|not\s*authenticated)/i;

export function extractCheckoutCandidate(payload, baseUrl) {
  const seen = new Set();
  const candidates = [];
  let orderId;

  function visit(value, key = '') {
    if (value === null || value === undefined) {
      return;
    }

    if (typeof value === 'string') {
      const absolute = absolutizeUrl(value, baseUrl);
      if (absolute && looksLikeCheckoutUrl(absolute)) {
        candidates.push(absolute);
      }
      if (!orderId && ORDER_ID_KEYS.test(key) && value.trim() !== '') {
        orderId = value;
      }
      return;
    }

    if (typeof value === 'number' && !orderId && ORDER_ID_KEYS.test(key)) {
      orderId = value;
      return;
    }

    if (typeof value !== 'object' || seen.has(value)) {
      return;
    }

    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, key));
      return;
    }

    for (const [nextKey, nextValue] of Object.entries(value)) {
      visit(nextValue, nextKey);
    }
  }

  visit(payload);
  return {
    checkoutUrl: candidates[0],
    orderId
  };
}

export function classifyText(text) {
  if (!text) {
    return null;
  }

  if (OUT_OF_STOCK_RE.test(text)) {
    return 'out_of_stock';
  }

  if (LOGIN_REQUIRED_RE.test(text)) {
    return 'login_required';
  }

  return null;
}
