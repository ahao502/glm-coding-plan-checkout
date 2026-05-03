import { mkdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stderr as output } from 'node:process';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { GLM_CODING_URL, STATUSES, STORAGE_STATE_PATH } from './constants.js';
import { classifyText, extractCheckoutCandidate } from './payload.js';
import { checkoutReady, failure, outOfStock } from './result.js';
import { formatDuration, formatLocalDateTime } from './time.js';
import { isAllowedCheckoutUrl, isCheckoutApiUrl, looksLikeCheckoutUrl } from './url.js';
import { buildRecipe, refreshDynamicTokens, replayRecipe, setupRequestCapture, shouldRefreshPage } from './api-capture.js';

const ACTION_TEXT_RE = /(立即购买|购买|订阅|开通|升级|Buy|Subscribe|Purchase)/i;
const MONTHLY_TEXT_RE = /(连续包月|自动续费|包月|monthly|recurring)/i;
const PRO_TEXT_RE = /\bpro\b|专业版|Pro/i;
const DEFAULT_ATTEMPT_SETTLE_MS = 1000;

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureStorageState(browserType = chromium) {
  if (await fileExists(STORAGE_STATE_PATH)) {
    return STORAGE_STATE_PATH;
  }

  await mkdir(dirname(STORAGE_STATE_PATH), { recursive: true });
  const browser = await browserType.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(GLM_CODING_URL, { waitUntil: 'domcontentloaded' });

  output.write(
    `No saved GLM login state found. Log in in the opened browser, then press Enter here to save ${STORAGE_STATE_PATH}.\n`
  );

  const rl = createInterface({ input, output });
  await rl.question('');
  rl.close();

  await context.storageState({ path: STORAGE_STATE_PATH });
  await browser.close();
  return STORAGE_STATE_PATH;
}

function checkoutResponseCandidate(response) {
  return response.request().method().toUpperCase() !== 'GET' && isCheckoutApiUrl(response.url());
}

async function responseToJsonOrText(response) {
  try {
    return await response.json();
  } catch {
    try {
      return await response.text();
    } catch {
      return null;
    }
  }
}

async function captureCheckoutFromResponse(response, pageUrl) {
  const body = await responseToJsonOrText(response);
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const status = classifyText(text);

  if (status === 'out_of_stock') {
    return outOfStock();
  }

  if (status === 'login_required' || response.status() === 401 || response.status() === 403) {
    return failure(STATUSES.LOGIN_REQUIRED);
  }

  if (body && typeof body === 'object') {
    const candidate = extractCheckoutCandidate(body, pageUrl);
    if (candidate.checkoutUrl) {
      return checkoutReady(candidate);
    }
  }

  return null;
}

async function chooseMonthlyIfPresent(page) {
  const monthly = page.getByText(MONTHLY_TEXT_RE).first();
  if ((await monthly.count()) === 0) {
    return;
  }

  try {
    await monthly.click({ timeout: 2000 });
  } catch {
    // Some pages render the selected billing mode as plain text; that is fine.
  }
}

async function clickProCheckoutAction(page, { lastClickedFingerprint = null } = {}) {
  await chooseMonthlyIfPresent(page);

  const proText = page.getByText(PRO_TEXT_RE).first();
  if ((await proText.count()) === 0) {
    return { clicked: false, fingerprint: null };
  }

  const result = await page.evaluate(
    ({ proSource, actionSource, skipFingerprint }) => {
      const proRe = new RegExp(proSource, 'i');
      const actionRe = new RegExp(actionSource, 'i');
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));

      function fingerprint(el) {
        const text = (el.innerText || el.textContent || '').trim().slice(0, 80);
        const classes = Array.from(el.classList || []).sort().join('.');
        return `${el.tagName.toLowerCase()}#${el.id || ''}.${classes}|${text}`;
      }

      function visible(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }

      function score(el) {
        const text = el.innerText || el.textContent || '';
        if (!actionRe.test(text) || !visible(el)) {
          return -1;
        }

        let current = el;
        for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
          const containerText = current.innerText || current.textContent || '';
          if (proRe.test(containerText)) {
            return 10 - depth;
          }
        }

        return 0;
      }

      const scored = candidates
        .map((el) => ({ el, score: score(el), fp: fingerprint(el) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score);

      const best = skipFingerprint
        ? scored.find((item) => item.fp !== skipFingerprint)
        : scored[0];

      if (!best) {
        return { clicked: false, fingerprint: null };
      }

      best.el.scrollIntoView({ block: 'center', inline: 'center' });
      best.el.click();
      return { clicked: true, fingerprint: best.fp };
    },
    {
      proSource: PRO_TEXT_RE.source,
      actionSource: ACTION_TEXT_RE.source,
      skipFingerprint: lastClickedFingerprint
    }
  );

  return result;
}

async function currentPageCheckoutUrl(page) {
  const url = page.url();
  if (looksLikeCheckoutUrl(url)) {
    return checkoutReady({ checkoutUrl: url });
  }

  for (const locator of [page.locator('a[href]').filter({ hasText: ACTION_TEXT_RE }), page.locator('a[href]')]) {
    const count = Math.min(await locator.count(), 20);
    for (let i = 0; i < count; i += 1) {
      const href = await locator.nth(i).getAttribute('href');
      try {
        const absolute = new URL(href, page.url()).toString();
        if (looksLikeCheckoutUrl(absolute) && isAllowedCheckoutUrl(absolute)) {
          return checkoutReady({ checkoutUrl: absolute });
        }
      } catch {
        // Ignore malformed href values.
      }
    }
  }

  return null;
}

async function pageRequiresLogin(page) {
  if (/\/login|\/signin|\/passport/i.test(page.url())) {
    return true;
  }

  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return /(请先登录|未登录|登录后|login\s+required|please\s+log\s+in)/i.test(body);
}

async function resetPageState(page) {
  await page.reload({ waitUntil: 'networkidle' });
  await chooseMonthlyIfPresent(page);
}

async function attemptCheckoutOnPage(page, { attemptSettleMs = DEFAULT_ATTEMPT_SETTLE_MS } = {}) {
  if (await pageRequiresLogin(page)) {
    return failure(STATUSES.LOGIN_REQUIRED);
  }

  const responsePromise = page
    .waitForResponse(checkoutResponseCandidate)
    .then((response) => captureCheckoutFromResponse(response, page.url()))
    .catch(() => null);

  const { clicked } = await clickProCheckoutAction(page);
  if (!clicked) {
    await Promise.race([responsePromise, defaultSleep(attemptSettleMs)]).catch(() => {});
    return failure(STATUSES.PLAN_NOT_FOUND);
  }

  const responseResult = await Promise.race([
    responsePromise,
    defaultSleep(attemptSettleMs).then(() => null)
  ]);

  const pageCheckout = await currentPageCheckoutUrl(page);
  if (pageCheckout) {
    return pageCheckout;
  }

  if (responseResult) {
    return responseResult;
  }

  const finalText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
  const finalTextStatus = classifyText(finalText);
  if (finalTextStatus === 'out_of_stock') {
    return outOfStock();
  }

  if (await pageRequiresLogin(page)) {
    return failure(STATUSES.LOGIN_REQUIRED);
  }

  return failure(STATUSES.CHECKOUT_NOT_CREATED);
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function abortError() {
  const error = new Error('Checkout task was stopped.');
  error.name = 'AbortError';
  return error;
}

async function sleepWithAbort(ms, { sleep, signal } = {}) {
  if (signal?.aborted) {
    throw abortError();
  }

  if (!signal) {
    await sleep(ms);
    return;
  }

  await Promise.race([
    sleep(ms),
    new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
    })
  ]);
}

async function waitUntilWithCountdown({
  target,
  now,
  sleep,
  output: logOutput,
  signal,
  onEvent,
  tickMs = 1000
}) {
  logOutput.write(`Page is ready. Next attempt starts at ${formatLocalDateTime(target)}.\n`);

  while (now() < target) {
    if (signal?.aborted) {
      throw abortError();
    }

    const remainingMs = target.getTime() - now().getTime();
    logOutput.write(`Time remaining: ${formatDuration(remainingMs)}\n`);
    onEvent?.({ type: 'countdown', timeRemainingMs: remainingMs });
    await sleepWithAbort(Math.min(tickMs, remainingMs), { sleep, signal });
  }
}

async function captureFirstCheckoutAttempt(page, { attemptSettleMs = DEFAULT_ATTEMPT_SETTLE_MS } = {}) {
  const { captured, dispose } = await setupRequestCapture(page);

  const responsePromise = page
    .waitForResponse(checkoutResponseCandidate)
    .then((r) => captureCheckoutFromResponse(r, page.url()))
    .catch(() => null);

  const { clicked } = await clickProCheckoutAction(page);

  if (!clicked) {
    dispose();
    await Promise.race([responsePromise, defaultSleep(attemptSettleMs)]).catch(() => {});
    return { recipe: null, responseResult: null, pageCheckout: null };
  }

  const responseResult = await Promise.race([
    responsePromise,
    defaultSleep(attemptSettleMs).then(() => null)
  ]);

  dispose();

  const pageCheckout = await currentPageCheckoutUrl(page);
  const recipe = buildRecipe(captured, pageCheckout);

  return { recipe, responseResult, pageCheckout };
}

export async function runFastClickCheckout({
  browserType = chromium,
  startAt,
  stopAt,
  now = () => new Date(),
  sleep = defaultSleep,
  retryIntervalMs = 500,
  attemptSettleMs = DEFAULT_ATTEMPT_SETTLE_MS,
  maxAttempts = Infinity,
  output: logOutput = output,
  signal,
  onEvent
} = {}) {
  const storageState = await ensureStorageState(browserType);
  const headless = process.env.GLM_HEADLESS === '1';
  const browser = await browserType.launch({ headless });
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  let attempts = 0;
  let lastStatus;

  try {
    onEvent?.({ type: 'preparing' });
    await page.goto(GLM_CODING_URL, { waitUntil: 'networkidle' });

    if (await pageRequiresLogin(page)) {
      return failure(STATUSES.LOGIN_REQUIRED);
    }

    await chooseMonthlyIfPresent(page);

    if (startAt && now() < startAt) {
      await waitUntilWithCountdown({
        target: startAt,
        now,
        sleep,
        output: logOutput,
        signal,
        onEvent
      });
    }

    let recipe = null;

    while (attempts < maxAttempts && (!stopAt || now() < stopAt)) {
      if (signal?.aborted) {
        throw abortError();
      }

      attempts += 1;
      logOutput.write(`Attempt ${attempts} at ${formatLocalDateTime(now())}.\n`);
      onEvent?.({ type: 'attempt', attempts });

      let result;

      if (recipe) {
        if (shouldRefreshPage(attempts, recipe)) {
          logOutput.write('Refreshing page to reset state.\n');
          onEvent?.({ type: 'log', message: '刷新页面以重置状态，并刷新 token', level: 'info' });
          await resetPageState(page);
          recipe = await refreshDynamicTokens(page, recipe);
        }

        const replayDetail = recipe.type === 'api'
          ? `${recipe.method} ${recipe.url}`
          : `导航到 ${recipe.url}`;
        logOutput.write(`Replaying captured ${recipe.type} recipe.\n`);
        onEvent?.({ type: 'log', message: `重放 recipe: ${replayDetail}`, level: 'info' });

        const replayResult = await replayRecipe(page, recipe);

        if (replayResult.error) {
          onEvent?.({ type: 'log', message: `重放请求失败: ${replayResult.error}`, level: 'error' });
        } else {
          const bodyPreview = typeof replayResult.body === 'string'
            ? replayResult.body.slice(0, 200)
            : JSON.stringify(replayResult.body).slice(0, 200);
          onEvent?.({
            type: 'log',
            message: `重放响应: HTTP ${replayResult.status}, body: ${bodyPreview}`,
            level: replayResult.ok ? 'info' : 'warn'
          });
        }

        if (replayResult.ok && replayResult.body && typeof replayResult.body === 'object') {
          const candidate = extractCheckoutCandidate(replayResult.body, page.url());
          if (candidate.checkoutUrl) {
            onEvent?.({ type: 'log', message: `从重放响应中提取到 checkout URL: ${candidate.checkoutUrl}`, level: 'info' });
            result = checkoutReady(candidate);
          }
        }

        if (!result) {
          const pageCheckout = await currentPageCheckoutUrl(page);
          if (pageCheckout) {
            onEvent?.({ type: 'log', message: `页面导航到 checkout URL: ${pageCheckout.checkoutUrl}`, level: 'info' });
            result = pageCheckout;
          }
        }

        if (!result) {
          logOutput.write('Recipe replay failed, falling back to DOM click.\n');
          onEvent?.({ type: 'log', message: '重放未生成 checkout，降级为 DOM 点击重试', level: 'warn' });
          await resetPageState(page);
          const { recipe: newRecipe, responseResult: rr, pageCheckout: pc } =
            await captureFirstCheckoutAttempt(page, { attemptSettleMs });
          if (newRecipe) {
            recipe = newRecipe;
            onEvent?.({ type: 'log', message: `重新捕获到 recipe: ${newRecipe.type === 'api' ? `${newRecipe.method} ${newRecipe.url}` : `导航 ${newRecipe.url}`}`, level: 'info' });
          }
          result = pc || rr;
          if (!result) {
            result = await attemptCheckoutOnPage(page, { attemptSettleMs });
          }
        }
      } else {
        logOutput.write('Capturing checkout request.\n');
        onEvent?.({ type: 'log', message: `第 ${attempts} 次尝试：首次点击并捕获 checkout API 请求`, level: 'info' });
        const { recipe: capturedRecipe, responseResult: rr, pageCheckout: pc } =
          await captureFirstCheckoutAttempt(page, { attemptSettleMs });

        recipe = capturedRecipe;
        result = pc || rr;

        if (recipe) {
          const detail = recipe.type === 'api'
            ? `${recipe.method} ${recipe.url}`
            : `导航 ${recipe.url}`;
          onEvent?.({ type: 'log', message: `成功捕获 recipe: ${detail}`, level: 'info' });
        } else {
          onEvent?.({ type: 'log', message: '未捕获到 checkout API 请求，后续使用 DOM 点击模式', level: 'warn' });
        }

        if (result) {
          onEvent?.({ type: 'log', message: `首次尝试结果: ${result.status}`, level: 'info' });
        }

        if (!result) {
          logOutput.write('No API captured, falling back to DOM click.\n');
          onEvent?.({ type: 'log', message: '降级为 DOM 点击重试', level: 'warn' });
          result = await attemptCheckoutOnPage(page, { attemptSettleMs });
        }
      }

      lastStatus = result?.status;
      onEvent?.({ type: 'result', result });

      if (result?.status === STATUSES.CHECKOUT_READY) {
        onEvent?.({ type: 'log', message: `抢购成功！checkout URL: ${result.checkoutUrl}`, level: 'info' });
        return {
          ...result,
          attempts
        };
      }

      if (result?.status === STATUSES.LOGIN_REQUIRED) {
        onEvent?.({ type: 'log', message: '登录态已过期，需要重新登录', level: 'error' });
        return {
          ...result,
          attempts
        };
      }

      if (attempts >= maxAttempts) {
        break;
      }

      if (stopAt) {
        const remainingMs = stopAt.getTime() - now().getTime();
        if (remainingMs <= 0) {
          break;
        }

        await sleepWithAbort(Math.min(retryIntervalMs, remainingMs), { sleep, signal });
      } else {
        await sleepWithAbort(retryIntervalMs, { sleep, signal });
      }
    }

    return failure(STATUSES.CHECKOUT_NOT_CREATED, {
      message: stopAt
        ? `Retry window ended at ${formatLocalDateTime(stopAt)} before checkout was created.`
        : 'Checkout was not created before the retry loop ended.',
      attempts,
      lastStatus
    });
  } finally {
    await context.storageState({ path: storageState }).catch(() => {});
    await browser.close();
  }
}

export async function runBrowserFlow({ browserType = chromium } = {}) {
  return runFastClickCheckout({ browserType, maxAttempts: 1 });
}
