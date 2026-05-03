import assert from 'node:assert/strict';
import test from 'node:test';
import { isCheckoutApiUrl } from '../src/url.js';
import {
  sanitizeHeaders,
  buildRecipe,
  shouldRefreshPage
} from '../src/api-capture.js';

test('isCheckoutApiUrl accepts checkout API URLs', () => {
  assert.equal(isCheckoutApiUrl('https://bigmodel.cn/api/order/create'), true);
  assert.equal(isCheckoutApiUrl('https://www.bigmodel.cn/api/pay/checkout'), true);
  assert.equal(isCheckoutApiUrl('https://bigmodel.cn/api/subscribe/pro'), true);
  assert.equal(isCheckoutApiUrl('https://bigmodel.cn/billing/plan'), true);
});

test('isCheckoutApiUrl rejects non-checkout and non-bigmodel URLs', () => {
  assert.equal(isCheckoutApiUrl('https://bigmodel.cn/user/settings'), false);
  assert.equal(isCheckoutApiUrl('https://bigmodel.cn/cli/download'), false);
  assert.equal(isCheckoutApiUrl('https://example.com/order/create'), false);
  assert.equal(isCheckoutApiUrl('http://bigmodel.cn/api/order/create'), false);
});

test('sanitizeHeaders strips connection-specific headers', () => {
  const headers = {
    'content-length': '123',
    host: 'bigmodel.cn',
    connection: 'keep-alive',
    'transfer-encoding': 'chunked',
    'keep-alive': 'timeout=5',
    te: 'trailers',
    trailer: 'x-foo',
    upgrade: 'h2c',
    via: 'proxy',
    'content-type': 'application/json',
    authorization: 'Bearer token',
    'x-csrf-token': 'abc123'
  };

  const cleaned = sanitizeHeaders(headers);

  assert.equal(cleaned['content-length'], undefined);
  assert.equal(cleaned.host, undefined);
  assert.equal(cleaned.connection, undefined);
  assert.equal(cleaned['transfer-encoding'], undefined);
  assert.equal(cleaned['content-type'], 'application/json');
  assert.equal(cleaned.authorization, 'Bearer token');
  assert.equal(cleaned['x-csrf-token'], 'abc123');
});

test('buildRecipe selects first POST/PUT over GET', () => {
  const captured = [
    { method: 'GET', url: 'https://bigmodel.cn/plan/pro', headers: {}, postData: null },
    { method: 'POST', url: 'https://bigmodel.cn/api/order/create', headers: { 'content-type': 'application/json' }, postData: '{"plan":"pro"}' }
  ];

  const recipe = buildRecipe(captured, null);

  assert.equal(recipe.type, 'api');
  assert.equal(recipe.url, 'https://bigmodel.cn/api/order/create');
  assert.equal(recipe.method, 'POST');
  assert.equal(recipe.postData, '{"plan":"pro"}');
});

test('buildRecipe falls back to navigation recipe when no mutation captured', () => {
  const captured = [
    { method: 'GET', url: 'https://bigmodel.cn/plan/pro', headers: {}, postData: null }
  ];
  const pageCheckout = { checkoutUrl: 'https://bigmodel.cn/pay/checkout/123' };

  const recipe = buildRecipe(captured, pageCheckout);

  assert.equal(recipe.type, 'navigation');
  assert.equal(recipe.url, 'https://bigmodel.cn/pay/checkout/123');
});

test('buildRecipe returns null when nothing captured and no page checkout', () => {
  assert.equal(buildRecipe([], null), null);

  const captured = [
    { method: 'GET', url: 'https://bigmodel.cn/glm-coding', headers: {}, postData: null }
  ];
  assert.equal(buildRecipe(captured, null), null);
});

test('shouldRefreshPage returns true on multiples of 5 for API recipes', () => {
  assert.equal(shouldRefreshPage(1, { type: 'api' }), false);
  assert.equal(shouldRefreshPage(3, { type: 'api' }), false);
  assert.equal(shouldRefreshPage(5, { type: 'api' }), true);
  assert.equal(shouldRefreshPage(10, { type: 'api' }), true);
  assert.equal(shouldRefreshPage(15, { type: 'api' }), true);
});

test('shouldRefreshPage always returns true for navigation recipes', () => {
  assert.equal(shouldRefreshPage(1, { type: 'navigation' }), true);
  assert.equal(shouldRefreshPage(3, { type: 'navigation' }), true);
  assert.equal(shouldRefreshPage(7, { type: 'navigation' }), true);
});

test('shouldRefreshPage returns false for non-multiples when recipe is null', () => {
  assert.equal(shouldRefreshPage(1, null), false);
  assert.equal(shouldRefreshPage(2, null), false);
  assert.equal(shouldRefreshPage(5, null), true);
});
