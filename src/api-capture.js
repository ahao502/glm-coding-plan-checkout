import { isCheckoutApiUrl, looksLikeCheckoutUrl } from './url.js';

const STRIP_HEADERS = new Set([
  'content-length', 'host', 'connection', 'transfer-encoding',
  'keep-alive', 'te', 'trailer', 'upgrade', 'via'
]);

export function sanitizeHeaders(headers) {
  const cleaned = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!STRIP_HEADERS.has(key.toLowerCase())) {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

export function isCheckoutApiRequest(request) {
  try {
    const url = new URL(request.url());
    const hostname = url.hostname;
    if (hostname !== 'bigmodel.cn' && !hostname.endsWith('.bigmodel.cn')) {
      return false;
    }
    return isCheckoutApiUrl(request.url());
  } catch {
    return false;
  }
}

export async function setupRequestCapture(page) {
  const captured = [];

  const handler = async (route, request) => {
    if (isCheckoutApiRequest(request)) {
      captured.push({
        url: request.url(),
        method: request.method(),
        headers: sanitizeHeaders(request.headers()),
        postData: request.postData() || null,
        capturedAt: Date.now()
      });
    }
    await route.continue();
  };

  await page.route('**/*', handler);
  return {
    captured,
    dispose: () => page.unroute('**/*', handler)
  };
}

export function buildRecipe(capturedRequests, pageCheckout) {
  const mutation = capturedRequests.find((r) => r.method !== 'GET');
  if (mutation) {
    return {
      type: 'api',
      url: mutation.url,
      method: mutation.method,
      headers: { ...mutation.headers },
      postData: mutation.postData,
      capturedAt: Date.now()
    };
  }

  if (pageCheckout?.checkoutUrl) {
    return {
      type: 'navigation',
      url: pageCheckout.checkoutUrl,
      capturedAt: Date.now()
    };
  }

  return null;
}

export async function replayRecipe(page, recipe) {
  if (recipe.type === 'navigation') {
    await page.goto(recipe.url, { waitUntil: 'networkidle' });
    return { body: null, status: 200, ok: true };
  }

  try {
    const result = await page.evaluate(async (r) => {
      const init = {
        method: r.method,
        headers: r.headers,
        credentials: 'include'
      };
      if (r.postData) {
        init.body = r.postData;
      }

      const res = await fetch(r.url, init);
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { body, status: res.status, ok: res.ok };
    }, recipe);

    return result;
  } catch (error) {
    return { body: null, status: 0, ok: false, error: error.message };
  }
}

export async function refreshDynamicTokens(page, recipe) {
  if (recipe.type !== 'api') {
    return recipe;
  }

  const csrfToken = await page.evaluate(() => {
    const meta = document.querySelector(
      'meta[name="csrf-token"], meta[name="csrfToken"], meta[name="_csrf"]'
    );
    return meta?.content || null;
  });

  if (!csrfToken) {
    return recipe;
  }

  const headers = { ...recipe.headers };
  for (const key of Object.keys(headers)) {
    if (/csrf|token/i.test(key)) {
      headers[key] = csrfToken;
    }
  }
  return { ...recipe, headers };
}

export function shouldRefreshPage(retryIndex, recipe) {
  if (recipe?.type === 'navigation') {
    return true;
  }
  return retryIndex % 5 === 0;
}
