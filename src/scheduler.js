import { stderr as defaultOutput } from 'node:process';
import { runFastClickCheckout } from './browser-flow.js';
import { formatLocalDateTime } from './time.js';

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
  retryIntervalMs = parseRetryIntervalMs(process.env.GLM_RETRY_INTERVAL_MS)
} = {}) {
  const base = now();
  const { startAt, stopAt } = nextCheckoutWindow(base);

  output.write(`Next checkout window: ${formatLocalDateTime(startAt)} - ${formatLocalDateTime(stopAt)}.\n`);
  output.write('Preparing checkout page.\n');

  return runCheckout({
    startAt,
    stopAt,
    now,
    output,
    retryIntervalMs
  });
}
