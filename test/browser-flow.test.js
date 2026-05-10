import assert from 'node:assert/strict';
import test from 'node:test';
import { selectProCheckoutActionState } from '../src/browser-flow.js';

test('selects a disabled Pro checkout action without treating it as clickable', () => {
  const state = selectProCheckoutActionState([
    {
      text: '立即购买',
      visible: true,
      disabled: true,
      fingerprint: 'button#buy|立即购买',
      proDepth: 1
    }
  ]);

  assert.deepEqual(state, {
    found: true,
    disabled: true,
    text: '立即购买',
    fingerprint: 'button#buy|立即购买'
  });
});

test('prefers an enabled checkout action over a disabled stale action', () => {
  const state = selectProCheckoutActionState([
    {
      text: '立即购买',
      visible: true,
      disabled: true,
      fingerprint: 'button#old|立即购买',
      proDepth: 0
    },
    {
      text: '立即购买',
      visible: true,
      disabled: false,
      fingerprint: 'button#new|立即购买',
      proDepth: 2
    }
  ]);

  assert.equal(state.disabled, false);
  assert.equal(state.fingerprint, 'button#new|立即购买');
});

test('can skip a previously clicked action fingerprint', () => {
  const state = selectProCheckoutActionState([
    {
      text: '立即购买',
      visible: true,
      disabled: false,
      fingerprint: 'button#first|立即购买',
      proDepth: 1
    },
    {
      text: '订阅',
      visible: true,
      disabled: false,
      fingerprint: 'button#second|订阅',
      proDepth: 1
    }
  ], { skipFingerprint: 'button#first|立即购买' });

  assert.equal(state.fingerprint, 'button#second|订阅');
});

test('ignores invisible or non-Pro checkout-looking actions', () => {
  const state = selectProCheckoutActionState([
    {
      text: '立即购买',
      visible: false,
      disabled: false,
      fingerprint: 'hidden',
      proDepth: 1
    },
    {
      text: '立即购买',
      visible: true,
      disabled: false,
      fingerprint: 'not-pro',
      proDepth: null
    }
  ]);

  assert.deepEqual(state, {
    found: false,
    disabled: null,
    text: '',
    fingerprint: null
  });
});
