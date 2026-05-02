import { DEFAULT_RETRY_INTERVAL_MS, nextCheckoutWindow } from './scheduler.js';
import { runFastClickCheckout } from './browser-flow.js';

const WINDOW_DURATION_MS = 5 * 60 * 1000;

function stoppedResult() {
  return {
    status: 'stopped'
  };
}

function cloneStatus(status) {
  return {
    ...status,
    lastResult: status.lastResult ? { ...status.lastResult } : null
  };
}

export function stopAtForStart(startAt) {
  return new Date(startAt.getTime() + WINDOW_DURATION_MS);
}

export function defaultStartAt(now = new Date()) {
  return nextCheckoutWindow(now).startAt;
}

export class CheckoutTaskManager {
  constructor({ runCheckout = runFastClickCheckout, now = () => new Date() } = {}) {
    this.runCheckout = runCheckout;
    this.now = now;
    this.controller = null;
    this.status = {
      running: false,
      status: 'idle',
      startAt: null,
      stopAt: null,
      retryIntervalMs: DEFAULT_RETRY_INTERVAL_MS,
      timeRemainingMs: 0,
      attempts: 0,
      lastResult: null
    };
  }

  getStatus() {
    if (this.status.running && this.status.startAt) {
      this.status.timeRemainingMs = Math.max(0, this.status.startAt.getTime() - this.now().getTime());
      if (this.status.timeRemainingMs > 0 && this.status.status === 'preparing') {
        this.status.status = 'countdown';
      }
    }

    return cloneStatus(this.status);
  }

  start({ startAt, retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS } = {}) {
    if (this.status.running || this.controller) {
      const error = new Error('Checkout task is already running.');
      error.code = 'TASK_ALREADY_RUNNING';
      throw error;
    }

    const resolvedStartAt = startAt ? new Date(startAt) : defaultStartAt(this.now());
    if (Number.isNaN(resolvedStartAt.getTime())) {
      const error = new Error('Invalid startAt.');
      error.code = 'INVALID_START_AT';
      throw error;
    }

    const resolvedRetryIntervalMs = Number(retryIntervalMs);
    const safeRetryIntervalMs =
      Number.isFinite(resolvedRetryIntervalMs) && resolvedRetryIntervalMs > 0
        ? resolvedRetryIntervalMs
        : DEFAULT_RETRY_INTERVAL_MS;
    const stopAt = stopAtForStart(resolvedStartAt);
    const controller = new AbortController();
    this.controller = controller;
    this.status = {
      running: true,
      status: 'preparing',
      startAt: resolvedStartAt,
      stopAt,
      retryIntervalMs: safeRetryIntervalMs,
      timeRemainingMs: Math.max(0, resolvedStartAt.getTime() - this.now().getTime()),
      attempts: 0,
      lastResult: null
    };

    const promise = this.runCheckout({
      startAt: resolvedStartAt,
      stopAt,
      retryIntervalMs: safeRetryIntervalMs,
      signal: controller.signal,
      now: this.now,
      onEvent: (event) => this.applyEvent(event)
    })
      .then((result) => {
        this.status.running = false;
        this.status.status = result.status === 'checkout_ready' ? 'success' : result.status;
        this.status.lastResult = result;
        this.status.attempts = result.attempts ?? this.status.attempts;
        return result;
      })
      .catch((error) => {
        this.status.running = false;
        if (controller.signal.aborted || error?.name === 'AbortError') {
          const result = stoppedResult();
          this.status.status = 'stopped';
          this.status.lastResult = result;
          return result;
        }

        const result = {
          status: 'contract_changed',
          message: error instanceof Error ? error.message : String(error)
        };
        this.status.status = 'failed';
        this.status.lastResult = result;
        return result;
      })
      .finally(() => {
        if (this.controller === controller) {
          this.controller = null;
        }
      });

    return promise;
  }

  stop() {
    if (!this.status.running || !this.controller) {
      this.status.status = this.status.status === 'idle' ? 'idle' : this.status.status;
      return false;
    }

    this.status.running = false;
    this.status.status = 'stopped';
    this.controller.abort();
    return true;
  }

  applyEvent(event) {
    if (!event || typeof event !== 'object') {
      return;
    }

    if (event.type === 'countdown') {
      this.status.status = 'countdown';
      this.status.timeRemainingMs = event.timeRemainingMs;
      return;
    }

    if (event.type === 'attempt') {
      this.status.status = 'attempting';
      this.status.attempts = event.attempts;
      this.status.timeRemainingMs = 0;
      return;
    }

    if (event.type === 'result') {
      this.status.lastResult = event.result;
      return;
    }

    if (event.type === 'preparing') {
      this.status.status = 'preparing';
    }
  }
}
