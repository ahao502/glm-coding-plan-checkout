import assert from 'node:assert/strict';
import test from 'node:test';
import { extractCheckoutCandidate, classifyText } from '../src/payload.js';

test('extracts checkout URL and order ID from nested payloads', () => {
  const result = extractCheckoutCandidate({
    code: 0,
    data: {
      orderId: 12345,
      payment: {
        cashierUrl: '/cashier/order-12345'
      }
    }
  }, 'https://bigmodel.cn/glm-coding');

  assert.deepEqual(result, {
    checkoutUrl: 'https://bigmodel.cn/cashier/order-12345',
    orderId: 12345
  });
});

test('classifies stock and login messages', () => {
  assert.equal(classifyText('Pro 连续包月 暂无库存'), 'out_of_stock');
  assert.equal(classifyText('抢购人数过多，请刷新再试'), 'busy_retryable');
  assert.equal(classifyText('please login first'), 'login_required');
  assert.equal(classifyText('everything ok'), null);
});
