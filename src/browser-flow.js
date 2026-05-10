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
import {
  buildRecipe,
  isCheckoutApiRequest,
  refreshDynamicTokens,
  replayRecipe,
  sanitizeHeaders,
  setupRequestCapture,
  shouldRefreshPage
} from './api-capture.js';
import { buildRecipeFromDiscoveryArtifacts, recipeDetail } from './checkout-discovery.js';

const ACTION_TEXT_RE = /(立即购买|购买|订阅|开通|升级|Buy|Subscribe|Purchase)/i;
const MONTHLY_TEXT_RE = /(连续包月|自动续费|包月|monthly|recurring)/i;
const PRO_TEXT_RE = /\bpro\b|专业版|Pro/i;
const DEFAULT_ATTEMPT_SETTLE_MS = 1000;
export const DEFAULT_PRE_START_REFRESH_MS = 3000;
export const DEFAULT_BUTTON_POLL_MS = 100;
export const DEFAULT_DISABLED_REFRESH_MS = 800;

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

function compactButtonText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function selectProCheckoutActionState(snapshots = [], { skipFingerprint = null } = {}) {
  const scored = snapshots
    .map((snapshot, index) => {
      const text = compactButtonText(snapshot.text);
      if (!ACTION_TEXT_RE.test(text) || !snapshot.visible || snapshot.proDepth == null) {
        return null;
      }

      return {
        ...snapshot,
        text,
        score: (snapshot.disabled ? 0 : 100) + (10 - snapshot.proDepth) - index
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  const best = skipFingerprint
    ? scored.find((item) => item.fingerprint !== skipFingerprint)
    : scored[0];

  if (!best) {
    return {
      found: false,
      disabled: null,
      text: '',
      fingerprint: null
    };
  }

  return {
    found: true,
    disabled: Boolean(best.disabled),
    text: best.text,
    fingerprint: best.fingerprint
  };
}

async function getProCheckoutActionState(page, { skipFingerprint = null, ensureMonthly = true } = {}) {
  if (ensureMonthly) {
    await chooseMonthlyIfPresent(page);
  }

  const snapshots = await page.evaluate(
    ({ proSource }) => {
      const proRe = new RegExp(proSource, 'i');
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

      function disabled(el) {
        return Boolean(
          el.disabled ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.closest('[disabled], [aria-disabled="true"]')
        );
      }

      function proDepth(el) {
        let current = el;
        for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
          const containerText = current.innerText || current.textContent || '';
          if (proRe.test(containerText)) {
            return depth;
          }
        }
        return null;
      }

      return candidates.map((el) => ({
        text: el.innerText || el.textContent || '',
        visible: visible(el),
        disabled: disabled(el),
        fingerprint: fingerprint(el),
        proDepth: proDepth(el)
      }));
    },
    {
      proSource: PRO_TEXT_RE.source
    }
  );

  return selectProCheckoutActionState(snapshots, { skipFingerprint });
}

async function clickProCheckoutAction(page, { lastClickedFingerprint = null } = {}) {
  const state = await getProCheckoutActionState(page, { skipFingerprint: lastClickedFingerprint });
  if (!state.found || state.disabled) {
    return { clicked: false, fingerprint: state.fingerprint, state };
  }

  const result = await page.evaluate(
    ({ fingerprintToClick }) => {
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

      function disabled(el) {
        return Boolean(
          el.disabled ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.closest('[disabled], [aria-disabled="true"]')
        );
      }

      const best = candidates.find((el) => fingerprint(el) === fingerprintToClick);
      if (!best || !visible(best) || disabled(best)) {
        return { clicked: false, fingerprint: fingerprintToClick };
      }

      best.scrollIntoView({ block: 'center', inline: 'center' });
      best.click();
      return { clicked: true, fingerprint: fingerprintToClick };
    },
    {
      fingerprintToClick: state.fingerprint
    }
  );

  return { ...result, state };
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

async function discoverCheckoutRecipeFromPage(page) {
  await chooseMonthlyIfPresent(page);

  const artifacts = await page.evaluate(
    ({ proSource, actionSource }) => {
      const proRe = new RegExp(proSource, 'i');
      const actionRe = new RegExp(actionSource, 'i');
      const controls = Array.from(document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]'));

      function textOf(el) {
        return (el.innerText || el.textContent || el.value || '').trim();
      }

      function visible(el) {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      }

      function disabled(el) {
        return Boolean(
          el.disabled ||
          el.getAttribute('aria-disabled') === 'true' ||
          el.closest('[disabled], [aria-disabled="true"]')
        );
      }

      function attrs(el, source) {
        return Array.from(el.attributes || [], (attr) => ({
          key: attr.name,
          value: attr.value,
          source
        }));
      }

      function pushAttrs(values, el, source) {
        values.push(...attrs(el, source));
        const text = textOf(el);
        if (text) {
          values.push({ key: 'text', value: text, source });
        }
      }

      function relevantControl(el) {
        const text = textOf(el);
        if (!actionRe.test(text) || !visible(el)) {
          return false;
        }

        let current = el;
        for (let depth = 0; current && depth < 7; depth += 1, current = current.parentElement) {
          const containerText = current.innerText || current.textContent || '';
          if (proRe.test(containerText)) {
            return true;
          }
        }
        return false;
      }

      function nearestProContainer(el) {
        let best = el;
        for (let depth = 0, current = el; current && depth < 7; depth += 1, current = current.parentElement) {
          const text = current.innerText || current.textContent || '';
          if (proRe.test(text)) {
            best = current;
          }
        }
        return best;
      }

      const artifacts = [];
      for (const control of controls.filter(relevantControl)) {
        const values = [];
        pushAttrs(values, control, disabled(control) ? 'disabled-control' : 'control');

        let current = control.parentElement;
        for (let depth = 0; current && depth < 4; depth += 1, current = current.parentElement) {
          pushAttrs(values, current, 'ancestor');
        }

        const container = nearestProContainer(control);
        const related = Array.from(container.querySelectorAll('a, button, form, input, [href], [action], [onclick], [data-url], [data-href], [data-api]')).slice(0, 80);
        for (const el of related) {
          pushAttrs(values, el, 'related');
        }

        const form = control.closest('form');
        if (form) {
          values.push({ key: 'formMethod', value: form.method || '', source: 'form' });
          pushAttrs(values, form, 'form');
          const params = new URLSearchParams(new FormData(form)).toString();
          if (params) {
            values.push({ key: 'formParams', value: params, source: 'form' });
          }
        }

        artifacts.push({
          disabled: disabled(control),
          method: control.getAttribute('method') || control.dataset?.method || null,
          formMethod: form?.method || null,
          values
        });
      }

      const scriptTexts = Array.from(document.scripts)
        .map((script) => script.textContent || '')
        .filter((text) => /checkout|cashier|pay|payment|order|purchase|subscribe|billing|trade/i.test(text))
        .slice(0, 10)
        .map((text) => text.slice(0, 20_000));

      if (artifacts.length > 0 && scriptTexts.length > 0) {
        artifacts.push({
          disabled: false,
          method: null,
          formMethod: null,
          values: scriptTexts.map((value) => ({ key: 'script', value, source: 'script' }))
        });
      }

      return artifacts;
    },
    {
      proSource: PRO_TEXT_RE.source,
      actionSource: ACTION_TEXT_RE.source
    }
  );

  return buildRecipeFromDiscoveryArtifacts(artifacts, page.url());
}

async function attemptDiscoveredRecipe(page, recipe, onEvent) {
  const detail = recipeDetail(recipe);
  onEvent?.({
    type: 'log',
    message: recipe.type === 'api' ? `尝试官方 API: ${detail}` : `打开解析到的购买页面: ${detail}`,
    level: 'info'
  });

  const replayResult = await replayRecipe(page, recipe);
  if (replayResult.error) {
    onEvent?.({ type: 'log', message: `官方入口触发失败: ${replayResult.error}`, level: 'error' });
    return null;
  }

  const bodyText = typeof replayResult.body === 'string' ? replayResult.body : JSON.stringify(replayResult.body);
  const bodyPreview = bodyText.slice(0, 200);
  onEvent?.({
    type: 'log',
    message: `官方入口响应: HTTP ${replayResult.status}, body: ${bodyPreview}`,
    level: replayResult.ok ? 'info' : 'warn'
  });

  const textStatus = classifyText(bodyText);
  if (textStatus === 'out_of_stock') {
    onEvent?.({ type: 'log', message: '服务端返回库存不足/未开放', level: 'warn' });
    return outOfStock();
  }

  if (textStatus === 'login_required' || replayResult.status === 401 || replayResult.status === 403) {
    onEvent?.({ type: 'log', message: '服务端返回需要登录或无权限', level: 'error' });
    return failure(STATUSES.LOGIN_REQUIRED);
  }

  if (replayResult.ok && replayResult.body && typeof replayResult.body === 'object') {
    const candidate = extractCheckoutCandidate(replayResult.body, page.url());
    if (candidate.checkoutUrl) {
      onEvent?.({ type: 'log', message: `成功解析 checkoutUrl: ${candidate.checkoutUrl}`, level: 'info' });
      return checkoutReady(candidate);
    }
  }

  const pageCheckout = await currentPageCheckoutUrl(page);
  if (pageCheckout) {
    onEvent?.({ type: 'log', message: `页面导航到 checkout URL: ${pageCheckout.checkoutUrl}`, level: 'info' });
    return pageCheckout;
  }

  if (!replayResult.ok) {
    onEvent?.({ type: 'log', message: `服务端拒绝官方入口: HTTP ${replayResult.status}`, level: 'warn' });
  }

  return null;
}

async function discoverAndAttemptCheckoutRecipe(page, onEvent) {
  const discoveredRecipe = await discoverCheckoutRecipeFromPage(page);
  if (!discoveredRecipe) {
    return { recipe: null, result: null };
  }

  onEvent?.({
    type: 'log',
    message: `解析到灰色按钮入口: ${recipeDetail(discoveredRecipe)}`,
    level: 'info'
  });

  const result = await attemptDiscoveredRecipe(page, discoveredRecipe, onEvent);
  return { recipe: discoveredRecipe, result };
}

async function pageRequiresLogin(page) {
  if (/\/login|\/signin|\/passport/i.test(page.url())) {
    return true;
  }

  const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  return /(请先登录|未登录|登录后|login\s+required|please\s+log\s+in)/i.test(body);
}

async function resetPageState(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await chooseMonthlyIfPresent(page);
}

async function classifySettledPage(page) {
  const pageCheckout = await currentPageCheckoutUrl(page);
  if (pageCheckout) {
    return pageCheckout;
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

  return classifySettledPage(page);
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

function installPassiveCheckoutRequestCapture(page, onEvent) {
  const captured = [];
  const handler = (request) => {
    if (!isCheckoutApiRequest(request)) {
      return;
    }

    const entry = {
      url: request.url(),
      method: request.method(),
      headers: sanitizeHeaders(request.headers()),
      postData: request.postData() || null,
      capturedAt: Date.now()
    };
    captured.push(entry);
    onEvent?.({
      type: 'log',
      message: `提前捕获到 checkout API 请求: ${entry.method} ${entry.url}`,
      level: 'info'
    });
  };

  page.on('request', handler);
  return {
    captured,
    dispose: () => page.off('request', handler)
  };
}

export async function runFastClickCheckout({
  browserType = chromium,
  startAt,
  stopAt,
  now = () => new Date(),
  sleep = defaultSleep,
  retryIntervalMs = 500,
  attemptSettleMs = DEFAULT_ATTEMPT_SETTLE_MS,
  preStartRefreshMs = DEFAULT_PRE_START_REFRESH_MS,
  buttonPollMs = DEFAULT_BUTTON_POLL_MS,
  disabledRefreshMs = DEFAULT_DISABLED_REFRESH_MS,
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
  const passiveCapture = installPassiveCheckoutRequestCapture(page, onEvent);
  let attempts = 0;
  let lastStatus;
  let lastButtonState = null;
  let sawEnabledButton = false;
  let nextDisabledRefreshAt = 0;

  try {
    onEvent?.({ type: 'preparing' });
    await page.goto(GLM_CODING_URL, { waitUntil: 'networkidle' });

    if (await pageRequiresLogin(page)) {
      return failure(STATUSES.LOGIN_REQUIRED);
    }

    await chooseMonthlyIfPresent(page);

    if (startAt && now() < startAt) {
      const preRefreshAt = new Date(startAt.getTime() - Math.max(0, preStartRefreshMs));
      if (preStartRefreshMs > 0 && now() < preRefreshAt) {
        await waitUntilWithCountdown({
          target: preRefreshAt,
          now,
          sleep,
          output: logOutput,
          signal,
          onEvent
        });
      }

      if (preStartRefreshMs > 0 && now() < startAt) {
        onEvent?.({
          type: 'log',
          message: `开始前 ${preStartRefreshMs}ms 刷新页面，更新购买按钮状态`,
          level: 'info'
        });
        await resetPageState(page);
      }

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
      const pageCheckout = await currentPageCheckoutUrl(page);
      if (pageCheckout) {
        result = pageCheckout;
      }

      if (!result && !recipe && passiveCapture.captured.length > 0) {
        recipe = buildRecipe(passiveCapture.captured, null);
        if (recipe) {
          onEvent?.({ type: 'log', message: `使用提前捕获的 checkout 入口: ${recipeDetail(recipe)}`, level: 'info' });
        }
      }

      const buttonState = !result && !recipe ? await getProCheckoutActionState(page, { ensureMonthly: false }) : null;
      if (buttonState?.found) {
        lastButtonState = buttonState;
        onEvent?.({
          type: 'log',
          message: `购买按钮状态: disabled=${buttonState.disabled}, text="${buttonState.text}"`,
          level: buttonState.disabled ? 'warn' : 'info'
        });
        if (!buttonState.disabled) {
          sawEnabledButton = true;
        }
      }

      if (!result && !recipe && buttonState?.found && buttonState.disabled) {
        const nowMs = now().getTime();
        if (nowMs >= nextDisabledRefreshAt) {
          onEvent?.({
            type: 'log',
            message: '购买按钮仍不可用，刷新页面等待开放',
            level: 'warn'
          });
          await resetPageState(page);
          nextDisabledRefreshAt = now().getTime() + Math.max(0, disabledRefreshMs);

          if (await pageRequiresLogin(page)) {
            result = failure(STATUSES.LOGIN_REQUIRED);
          } else {
            const refreshedText = await page.locator('body').innerText({ timeout: 1000 }).catch(() => '');
            if (classifyText(refreshedText) === 'out_of_stock') {
              result = outOfStock();
            }
          }
        }

        if (!result) {
          const remainingMs = stopAt ? stopAt.getTime() - now().getTime() : buttonPollMs;
          if (remainingMs <= 0) {
            break;
          }
          await sleepWithAbort(Math.min(Math.max(1, buttonPollMs), remainingMs), { sleep, signal });
          continue;
        }
      }

      if (!result && recipe) {
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

        result = await attemptDiscoveredRecipe(page, recipe, onEvent);

        if (!result) {
          const pageCheckout = await currentPageCheckoutUrl(page);
          if (pageCheckout) {
            onEvent?.({ type: 'log', message: `页面导航到 checkout URL: ${pageCheckout.checkoutUrl}`, level: 'info' });
            result = pageCheckout;
          }
        }

        if (!result) {
          logOutput.write('Recipe replay failed, falling back to DOM click.\n');
          onEvent?.({ type: 'log', message: '重放未生成 checkout，重新扫描灰色按钮入口', level: 'warn' });
          await resetPageState(page);
          const discovery = await discoverAndAttemptCheckoutRecipe(page, onEvent);
          if (discovery.recipe) {
            recipe = discovery.recipe;
          }
          if (!result) {
            result = discovery.result;
          }
          if (!result) {
            onEvent?.({ type: 'log', message: '灰色按钮入口仍未生成 checkout，降级为 DOM 点击重试', level: 'warn' });
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
        }
      }

      if (!result && !recipe) {
        if (buttonState?.found && !buttonState.disabled) {
          onEvent?.({ type: 'log', message: '购买按钮已可用，立即点击并捕获 checkout API 请求', level: 'info' });
          const { recipe: capturedRecipe, responseResult: rr, pageCheckout: pc } =
            await captureFirstCheckoutAttempt(page, { attemptSettleMs });
          recipe = capturedRecipe;
          result = pc || rr || await classifySettledPage(page);
        } else {
          logOutput.write('Capturing checkout request.\n');
          onEvent?.({ type: 'log', message: `第 ${attempts} 次尝试：扫描购买入口`, level: 'info' });
          const discovery = await discoverAndAttemptCheckoutRecipe(page, onEvent);
          recipe = discovery.recipe;
          result = discovery.result;

          if (!result) {
            onEvent?.({ type: 'log', message: '未从页面入口生成 checkout，首次点击并捕获 checkout API 请求', level: 'warn' });
            const { recipe: capturedRecipe, responseResult: rr, pageCheckout: pc } =
              await captureFirstCheckoutAttempt(page, { attemptSettleMs });

            recipe = recipe || capturedRecipe;
            result = pc || rr;
          }

          if (recipe) {
            onEvent?.({ type: 'log', message: `当前可复用 recipe: ${recipeDetail(recipe)}`, level: 'info' });
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

      if (result?.status === STATUSES.OUT_OF_STOCK) {
        onEvent?.({ type: 'log', message: '服务端确认库存不足/未开放', level: 'warn' });
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

    if (!sawEnabledButton && lastButtonState?.disabled) {
      return failure(STATUSES.BUTTON_NEVER_ENABLED, {
        message: stopAt
          ? `Retry window ended at ${formatLocalDateTime(stopAt)} while the purchase button stayed disabled.`
          : 'Purchase button stayed disabled before the retry loop ended.',
        attempts,
        lastStatus,
        button: {
          disabled: lastButtonState.disabled,
          text: lastButtonState.text
        }
      });
    }

    return failure(STATUSES.CHECKOUT_NOT_CREATED, {
      message: stopAt
        ? `Retry window ended at ${formatLocalDateTime(stopAt)} before checkout was created.`
        : 'Checkout was not created before the retry loop ended.',
      attempts,
      lastStatus
    });
  } finally {
    passiveCapture.dispose();
    await context.storageState({ path: storageState }).catch(() => {});
    await browser.close();
  }
}

export async function runBrowserFlow({ browserType = chromium } = {}) {
  return runFastClickCheckout({ browserType, maxAttempts: 1 });
}
