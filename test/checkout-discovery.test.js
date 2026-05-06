import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRecipeFromDiscoveryArtifacts } from '../src/checkout-discovery.js';

const BASE_URL = 'https://bigmodel.cn/glm-coding';

test('builds API recipe from disabled control data URL', () => {
  const recipe = buildRecipeFromDiscoveryArtifacts([
    {
      disabled: true,
      method: null,
      values: [
        { key: 'data-url', value: '/api/order/create', source: 'disabled-control' },
        { key: 'text', value: '立即购买', source: 'disabled-control' }
      ]
    }
  ], BASE_URL);

  assert.equal(recipe.type, 'api');
  assert.equal(recipe.url, 'https://bigmodel.cn/api/order/create');
  assert.equal(recipe.method, 'POST');
  assert.equal(recipe.postData, null);
});

test('uses explicit method when building API recipe', () => {
  const recipe = buildRecipeFromDiscoveryArtifacts([
    {
      disabled: true,
      method: 'put',
      values: [
        { key: 'data-api', value: '/api/pay/checkout', source: 'disabled-control' }
      ]
    }
  ], BASE_URL);

  assert.equal(recipe.type, 'api');
  assert.equal(recipe.method, 'PUT');
});

test('preserves form params when building API recipe', () => {
  const recipe = buildRecipeFromDiscoveryArtifacts([
    {
      disabled: true,
      formMethod: 'post',
      values: [
        { key: 'action', value: '/api/order/create', source: 'form' },
        { key: 'formParams', value: 'plan=pro&billing=monthly_recurring', source: 'form' }
      ]
    }
  ], BASE_URL);

  assert.equal(recipe.type, 'api');
  assert.equal(recipe.method, 'POST');
  assert.equal(recipe.postData, 'plan=pro&billing=monthly_recurring');
  assert.equal(recipe.headers['content-type'], 'application/x-www-form-urlencoded;charset=UTF-8');
});


test('builds navigation recipe from nearby cashier link', () => {
  const recipe = buildRecipeFromDiscoveryArtifacts([
    {
      disabled: true,
      values: [
        { key: 'href', value: '/cashier/order-123', source: 'related' }
      ]
    }
  ], BASE_URL);

  assert.equal(recipe.type, 'navigation');
  assert.equal(recipe.url, 'https://bigmodel.cn/cashier/order-123');
});

test('extracts checkout URL from onclick script', () => {
  const recipe = buildRecipeFromDiscoveryArtifacts([
    {
      disabled: true,
      values: [
        { key: 'onclick', value: "location.href='/pay/abc'", source: 'disabled-control' }
      ]
    }
  ], BASE_URL);

  assert.equal(recipe.type, 'navigation');
  assert.equal(recipe.url, 'https://bigmodel.cn/pay/abc');
});

test('rejects non-BigModel and non-checkout hints', () => {
  assert.equal(buildRecipeFromDiscoveryArtifacts([
    {
      disabled: true,
      values: [
        { key: 'data-url', value: 'https://example.com/api/order/create', source: 'disabled-control' }
      ]
    }
  ], BASE_URL), null);

  assert.equal(buildRecipeFromDiscoveryArtifacts([
    {
      disabled: true,
      values: [
        { key: 'data-url', value: '/user/settings', source: 'disabled-control' }
      ]
    }
  ], BASE_URL), null);
});
