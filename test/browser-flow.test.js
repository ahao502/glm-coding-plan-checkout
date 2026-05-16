import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyProCardText,
  retryDelayBeforeStop,
  selectCheckoutActionState,
  selectProCheckoutActionState
} from '../src/browser-flow.js';

const NOW = new Date(2026, 4, 10, 10, 0, 0);

test('selects a disabled Pro checkout action without treating it as clickable', () => {
  const state = selectProCheckoutActionState([
    {
      text: '立即购买',
      visible: true,
      disabled: true,
      fingerprint: 'button#buy|立即购买',
      proDepth: 1
    }
  ], { now: NOW });

  assert.deepEqual(state, {
    found: true,
    disabled: true,
    text: '立即购买',
    fingerprint: 'button#buy|立即购买',
    cardState: 'disabled',
    restockAt: null
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
  ], { now: NOW });

  assert.equal(state.disabled, false);
  assert.equal(state.fingerprint, 'button#new|立即购买');
  assert.equal(state.cardState, 'available');
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
  ], { skipFingerprint: 'button#first|立即购买', now: NOW });

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
  ], { now: NOW });

  assert.deepEqual(state, {
    found: false,
    disabled: null,
    text: '',
    fingerprint: null
  });
});

test('classifies busy retryable Pro card text from the screenshot', () => {
  assert.deepEqual(classifyProCardText('抢购人数过多，请刷新再试', { disabled: true, now: NOW }), {
    cardState: 'busy_retryable',
    restockAt: null
  });
});

test('classifies scheduled restock text and extracts the restock time', () => {
  const state = classifyProCardText('暂时售罄 | 05月11日 10:00 补货', { disabled: true, now: NOW });

  assert.equal(state.cardState, 'scheduled_restock');
  assert.equal(state.restockAt.toISOString(), new Date(2026, 4, 11, 10, 0, 0).toISOString());
});

test('prefers current Pro card state over non-target card states', () => {
  const state = selectProCheckoutActionState([
    {
      text: '抢购人数过多，请刷新再试',
      visible: true,
      disabled: true,
      fingerprint: 'lite',
      proDepth: null
    },
    {
      text: '暂时售罄 | 05月11日 10:00 补货',
      visible: true,
      disabled: true,
      fingerprint: 'pro',
      proDepth: 1
    },
    {
      text: '立即购买',
      visible: true,
      disabled: false,
      fingerprint: 'max',
      proDepth: null
    }
  ], { now: NOW });

  assert.equal(state.fingerprint, 'pro');
  assert.equal(state.cardState, 'scheduled_restock');
});

test('selects the configured plan card by plan depth', () => {
  const state = selectCheckoutActionState([
    {
      text: '抢购人数过多，请刷新再试',
      visible: true,
      disabled: true,
      fingerprint: 'lite-card',
      planDepth: null
    },
    {
      text: '立即购买',
      visible: true,
      disabled: false,
      fingerprint: 'max-card',
      planDepth: 2
    }
  ], { now: NOW });

  assert.equal(state.fingerprint, 'max-card');
  assert.equal(state.cardState, 'available');
});

test('keeps retrying out-of-stock responses inside the retry window', () => {
  const stopAt = new Date(2026, 4, 16, 10, 15, 0);

  assert.equal(
    retryDelayBeforeStop({
      now: new Date(2026, 4, 16, 10, 0, 17),
      stopAt,
      intervalMs: 500
    }),
    500
  );

  assert.equal(
    retryDelayBeforeStop({
      now: new Date(2026, 4, 16, 10, 14, 59, 800),
      stopAt,
      intervalMs: 500
    }),
    200
  );
});

test('stops retrying out-of-stock responses after the retry window', () => {
  const stopAt = new Date(2026, 4, 16, 10, 15, 0);

  assert.equal(
    retryDelayBeforeStop({
      now: stopAt,
      stopAt,
      intervalMs: 500
    }),
    null
  );
});
