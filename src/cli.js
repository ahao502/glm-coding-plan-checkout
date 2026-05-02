#!/usr/bin/env node

import { STATUSES } from './constants.js';
import { runScheduledCheckout } from './scheduler.js';
import { failure, printJson } from './result.js';

try {
  const result = await runScheduledCheckout();
  printJson(result);
  process.exitCode = result.status === STATUSES.CHECKOUT_READY ? 0 : 1;
} catch (error) {
  printJson(
    failure(STATUSES.CONTRACT_CHANGED, {
      message: error instanceof Error ? error.message : String(error)
    })
  );
  process.exitCode = 1;
}
