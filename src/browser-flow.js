import { mkdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stderr as output } from 'node:process';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { GLM_CODING_URL, STATUSES, STORAGE_STATE_PATH } from './constants.js';
import { classifyText, extractCheckoutCandidate } from './payload.js';
import { checkoutReady, failure, outOfStock } from './result.js';
import { isAllowedCheckoutUrl, looksLikeCheckoutUrl } from './url.js';

const ACTION_TEXT_RE = /(立即购买|购买|订阅|开通|升级|Buy|Subscribe|Purchase)/i;
const MONTHLY_TEXT_RE = /(连续包月|自动续费|包月|monthly|recurring)/i;
const PRO_TEXT_RE = /\bpro\b|专业版|Pro/i;

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

function sameSiteResponse(response) {
  const url = new URL(response.url());
  return url.hostname === 'bigmodel.cn' || url.hostname.endsWith('.bigmodel.cn');
}

function checkoutResponseCandidate(response) {
  const req = response.request();
  const method = req.method().toUpperCase();
  const url = response.url();
  return (
    sameSiteResponse(response) &&
    method !== 'GET' &&
    /(order|trade|pay|checkout|purchase|subscribe|billing|plan|coding)/i.test(url)
  );
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

async function clickProCheckoutAction(page) {
  await chooseMonthlyIfPresent(page);

  const proText = page.getByText(PRO_TEXT_RE).first();
  if ((await proText.count()) === 0) {
    return false;
  }

  const clicked = await page.evaluate(
    ({ proSource, actionSource }) => {
      const proRe = new RegExp(proSource, 'i');
      const actionRe = new RegExp(actionSource, 'i');
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));

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

      const target = candidates
        .map((el) => ({ el, score: score(el) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)[0]?.el;

      if (!target) {
        return false;
      }

      target.scrollIntoView({ block: 'center', inline: 'center' });
      target.click();
      return true;
    },
    {
      proSource: PRO_TEXT_RE.source,
      actionSource: ACTION_TEXT_RE.source
    }
  );

  return clicked;
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

export async function runBrowserFlow({ browserType = chromium } = {}) {
  const storageState = await ensureStorageState(browserType);
  const headless = process.env.GLM_HEADLESS === '1';
  const browser = await browserType.launch({ headless });
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  const capturedResults = [];

  page.on('response', async (response) => {
    if (!checkoutResponseCandidate(response)) {
      return;
    }

    const result = await captureCheckoutFromResponse(response, page.url());
    if (result) {
      capturedResults.push(result);
    }
  });

  try {
    await page.goto(GLM_CODING_URL, { waitUntil: 'networkidle' });

    if (await pageRequiresLogin(page)) {
      return failure(STATUSES.LOGIN_REQUIRED);
    }

    const clicked = await clickProCheckoutAction(page);
    if (!clicked) {
      return failure(STATUSES.PLAN_NOT_FOUND);
    }

    await page.waitForTimeout(5000);

    const pageCheckout = await currentPageCheckoutUrl(page);
    if (pageCheckout) {
      return pageCheckout;
    }

    const responseResult = capturedResults.find((result) => result.status === STATUSES.CHECKOUT_READY) || capturedResults[0];
    if (responseResult) {
      return responseResult;
    }

    const finalText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const finalTextStatus = classifyText(finalText);
    if (finalTextStatus === 'out_of_stock') {
      return outOfStock();
    }

    if (await pageRequiresLogin(page)) {
      return failure(STATUSES.LOGIN_REQUIRED);
    }

    return failure(STATUSES.CHECKOUT_NOT_CREATED);
  } finally {
    await context.storageState({ path: storageState }).catch(() => {});
    await browser.close();
  }
}
