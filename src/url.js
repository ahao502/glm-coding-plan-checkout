const ALLOWED_CHECKOUT_HOSTS = new Set(['bigmodel.cn', 'www.bigmodel.cn']);
const CHECKOUT_PATH_HINTS = /(checkout|cashier|pay|payment|order|purchase|subscribe|billing|trade)/i;
const CHECKOUT_API_PATH_HINTS = /(order|trade|pay|checkout|purchase|subscribe|billing|plan|coding)/i;

export function isAllowedCheckoutUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ALLOWED_CHECKOUT_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function looksLikeCheckoutUrl(value) {
  if (!isAllowedCheckoutUrl(value)) {
    return false;
  }

  const url = new URL(value);
  const haystack = `${url.pathname}${url.search}${url.hash}`;
  return CHECKOUT_PATH_HINTS.test(haystack);
}

export function isCheckoutApiUrl(value) {
  if (!isAllowedCheckoutUrl(value)) {
    return false;
  }

  const url = new URL(value);
  const haystack = `${url.pathname}${url.search}${url.hash}`;
  return CHECKOUT_API_PATH_HINTS.test(haystack);
}

export function absolutizeUrl(value, baseUrl = 'https://bigmodel.cn') {
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }

  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
}
