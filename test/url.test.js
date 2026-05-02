import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedCheckoutUrl, looksLikeCheckoutUrl } from '../src/url.js';

test('accepts only exact GLM checkout hosts over HTTPS', () => {
  assert.equal(isAllowedCheckoutUrl('https://bigmodel.cn/order/123'), true);
  assert.equal(isAllowedCheckoutUrl('https://www.bigmodel.cn/pay/123'), true);
  assert.equal(isAllowedCheckoutUrl('http://bigmodel.cn/pay/123'), false);
  assert.equal(isAllowedCheckoutUrl('https://evil.bigmodel.cn/pay/123'), false);
  assert.equal(isAllowedCheckoutUrl('https://example.com/pay/123'), false);
});

test('requires checkout-like URL path hints', () => {
  assert.equal(looksLikeCheckoutUrl('https://bigmodel.cn/cashier/order-123'), true);
  assert.equal(looksLikeCheckoutUrl('https://bigmodel.cn/glm-coding'), false);
});
