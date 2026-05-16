import { DEFAULT_RETRY_INTERVAL_MS, nextCheckoutWindow } from './scheduler.js';
import { runFastClickCheckout } from './browser-flow.js';
import { createDailyJsonlLogger } from './file-logger.js';
import { BILLING, normalizeBilling, normalizePlan, PLAN } from './constants.js';

const WINDOW_DURATION_MS = 15 * 60 * 1000;

function stoppedResult() {
  return {
    status: 'stopped'
  };
}

function cloneStatus(status) {
  return {
    ...status,
    lastResult: status.lastResult ? { ...status.lastResult } : null,
    logs: status.logs ? [...status.logs] : []
  };
}

export function stopAtForStart(startAt) {
  return new Date(startAt.getTime() + WINDOW_DURATION_MS);
}

export function defaultStartAt(now = new Date()) {
  return nextCheckoutWindow(now).startAt;
}

export class CheckoutTaskManager {
  constructor({ runCheckout = runFastClickCheckout, now = () => new Date(), createLogger = createDailyJsonlLogger } = {}) {
    this.runCheckout = runCheckout;
    this.now = now;
    this.createLogger = createLogger;
    this.controller = null;
    this.logger = null;
    this.status = {
      running: false,
      status: 'idle',
      startAt: null,
      stopAt: null,
      plan: PLAN,
      billing: BILLING,
      retryIntervalMs: DEFAULT_RETRY_INTERVAL_MS,
      timeRemainingMs: 0,
      attempts: 0,
      lastResult: null,
      logs: []
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

  start({ startAt, plan = PLAN, billing = BILLING, retryIntervalMs = DEFAULT_RETRY_INTERVAL_MS } = {}) {
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

    const resolvedPlan = normalizePlan(plan);
    const resolvedBilling = normalizeBilling(billing);
    const resolvedRetryIntervalMs = Number(retryIntervalMs);
    const safeRetryIntervalMs =
      Number.isFinite(resolvedRetryIntervalMs) && resolvedRetryIntervalMs > 0
        ? resolvedRetryIntervalMs
        : DEFAULT_RETRY_INTERVAL_MS;
    const stopAt = stopAtForStart(resolvedStartAt);
    const controller = new AbortController();
    this.controller = controller;
    this.logger = this.createLogger({ now: this.now });
    this.status = {
      running: true,
      status: 'preparing',
      startAt: resolvedStartAt,
      stopAt,
      plan: resolvedPlan,
      billing: resolvedBilling,
      retryIntervalMs: safeRetryIntervalMs,
      timeRemainingMs: Math.max(0, resolvedStartAt.getTime() - this.now().getTime()),
      attempts: 0,
      lastResult: null,
      logs: []
    };
    this.writeLogEvent('task_started', {
      message: 'Checkout task started.',
      data: {
        startAt: resolvedStartAt.toISOString(),
        stopAt: stopAt.toISOString(),
        plan: resolvedPlan,
        billing: resolvedBilling,
        retryIntervalMs: safeRetryIntervalMs
      }
    });

    const promise = this.runCheckout({
      startAt: resolvedStartAt,
      stopAt,
      plan: resolvedPlan,
      billing: resolvedBilling,
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
        this.writeLogEvent('task_finished', {
          status: this.status.status,
          attempts: this.status.attempts,
          message: 'Checkout task finished.',
          data: result
        });
        return result;
      })
      .catch((error) => {
        this.status.running = false;
        if (controller.signal.aborted || error?.name === 'AbortError') {
          const result = stoppedResult();
          this.status.status = 'stopped';
          this.status.lastResult = result;
          this.writeLogEvent('task_stopped', {
            level: 'warn',
            status: this.status.status,
            attempts: this.status.attempts,
            message: 'Checkout task stopped.',
            data: result
          });
          return result;
        }

        const result = {
          status: 'contract_changed',
          message: error instanceof Error ? error.message : String(error)
        };
        this.status.status = 'failed';
        this.status.lastResult = result;
        this.writeLogEvent('task_failed', {
          level: 'error',
          status: this.status.status,
          attempts: this.status.attempts,
          message: result.message,
          data: result
        });
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
      this.writeLogEvent('countdown', {
        status: this.status.status,
        attempts: this.status.attempts,
        message: 'Checkout countdown tick.',
        data: { timeRemainingMs: event.timeRemainingMs }
      });
      return;
    }

    if (event.type === 'attempt') {
      this.status.status = 'attempting';
      this.status.attempts = event.attempts;
      this.status.timeRemainingMs = 0;
      this.writeLogEvent('attempt', {
        status: this.status.status,
        attempts: this.status.attempts,
        message: `Checkout attempt ${this.status.attempts}.`,
        data: event
      });
      return;
    }

    if (event.type === 'result') {
      this.status.lastResult = event.result;
      this.writeLogEvent('result', {
        status: event.result?.status,
        attempts: this.status.attempts,
        message: `Checkout result: ${event.result?.status || 'unknown'}.`,
        data: event.result
      });
      return;
    }

    if (event.type === 'preparing') {
      this.status.status = 'preparing';
      this.writeLogEvent('preparing', {
        status: this.status.status,
        attempts: this.status.attempts,
        message: 'Preparing checkout page.'
      });
      return;
    }

    if (event.type === 'log') {
      const entry = {
        time: this.now().toISOString(),
        message: event.message || '',
        level: event.level || 'info'
      };
      this.status.logs.push(entry);
      if (this.status.logs.length > 200) {
        this.status.logs = this.status.logs.slice(-200);
      }
      this.writeLogEvent('log', {
        level: entry.level,
        status: this.status.status,
        attempts: this.status.attempts,
        message: entry.message,
        data: event
      });
    }
  }

  writeLogEvent(eventType, entry = {}) {
    if (!this.logger?.write) {
      return;
    }

    this.logger.write({
      eventType,
      level: entry.level,
      status: entry.status ?? this.status.status,
      attempts: entry.attempts ?? this.status.attempts,
      message: entry.message,
      data: entry.data
    }).catch(() => {});
  }
}
