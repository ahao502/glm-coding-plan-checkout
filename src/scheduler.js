import { stderr as defaultOutput } from 'node:process';
import { runFastClickCheckout } from './browser-flow.js';
import { createDailyJsonlLogger } from './file-logger.js';
import { formatLocalDateTime } from './time.js';
import { BILLING, normalizeBilling, normalizePlan, PLAN } from './constants.js';

export const DEFAULT_RETRY_INTERVAL_MS = 500;
export const WINDOW_START = Object.freeze({ hour: 10, minute: 0 });
export const WINDOW_STOP = Object.freeze({ hour: 10, minute: 5 });

function localTodayAt(now, { hour, minute }) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute, 0, 0);
}

export function nextCheckoutWindow(base) {
  let startAt = localTodayAt(base, WINDOW_START);
  let stopAt = localTodayAt(base, WINDOW_STOP);

  if (base >= stopAt) {
    startAt = new Date(startAt.getTime());
    startAt.setDate(startAt.getDate() + 1);
    stopAt = new Date(stopAt.getTime());
    stopAt.setDate(stopAt.getDate() + 1);
  }

  return { startAt, stopAt };
}

function parseRetryIntervalMs(value) {
  if (!value) {
    return DEFAULT_RETRY_INTERVAL_MS;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RETRY_INTERVAL_MS;
}

export async function runScheduledCheckout({
  runCheckout = runFastClickCheckout,
  now = () => new Date(),
  output = defaultOutput,
  plan = PLAN,
  billing = BILLING,
  retryIntervalMs = parseRetryIntervalMs(process.env.GLM_RETRY_INTERVAL_MS),
  createLogger = createDailyJsonlLogger,
  onEvent
} = {}) {
  const base = now();
  const { startAt, stopAt } = nextCheckoutWindow(base);
  const resolvedPlan = normalizePlan(plan);
  const resolvedBilling = normalizeBilling(billing);
  const logger = createLogger({ now });
  const pendingWrites = [];

  function writeLogEvent(eventType, entry = {}) {
    if (!logger?.write) {
      return;
    }

    pendingWrites.push(logger.write({
      eventType,
      level: entry.level,
      status: entry.status,
      attempts: entry.attempts,
      message: entry.message,
      data: entry.data
    }).catch(() => {}));
  }

  function handleEvent(event) {
    onEvent?.(event);

    if (!event || typeof event !== 'object') {
      return;
    }

    if (event.type === 'countdown') {
      writeLogEvent('countdown', {
        message: 'Checkout countdown tick.',
        data: { timeRemainingMs: event.timeRemainingMs }
      });
      return;
    }

    if (event.type === 'attempt') {
      writeLogEvent('attempt', {
        attempts: event.attempts,
        message: `Checkout attempt ${event.attempts}.`,
        data: event
      });
      return;
    }

    if (event.type === 'result') {
      writeLogEvent('result', {
        status: event.result?.status,
        attempts: event.result?.attempts,
        message: `Checkout result: ${event.result?.status || 'unknown'}.`,
        data: event.result
      });
      return;
    }

    if (event.type === 'preparing') {
      writeLogEvent('preparing', {
        status: 'preparing',
        message: 'Preparing checkout page.'
      });
      return;
    }

    if (event.type === 'log') {
      writeLogEvent('log', {
        level: event.level || 'info',
        message: event.message || '',
        data: event
      });
    }
  }

  output.write(`Next checkout window: ${formatLocalDateTime(startAt)} - ${formatLocalDateTime(stopAt)}.\n`);
  output.write('Preparing checkout page.\n');
  writeLogEvent('task_started', {
    message: 'Scheduled checkout task started.',
    data: {
      startAt: startAt.toISOString(),
      stopAt: stopAt.toISOString(),
      plan: resolvedPlan,
      billing: resolvedBilling,
      retryIntervalMs
    }
  });

  try {
    const result = await runCheckout({
      startAt,
      stopAt,
      plan: resolvedPlan,
      billing: resolvedBilling,
      now,
      output,
      retryIntervalMs,
      onEvent: handleEvent
    });
    writeLogEvent('task_finished', {
      status: result.status,
      attempts: result.attempts,
      message: 'Scheduled checkout task finished.',
      data: result
    });
    return result;
  } catch (error) {
    writeLogEvent('task_failed', {
      level: 'error',
      status: 'contract_changed',
      message: error instanceof Error ? error.message : String(error),
      data: { message: error instanceof Error ? error.message : String(error) }
    });
    throw error;
  } finally {
    await Promise.all(pendingWrites);
  }
}
