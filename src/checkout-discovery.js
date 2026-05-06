import { absolutizeUrl, isAllowedCheckoutUrl, isCheckoutApiUrl, looksLikeCheckoutUrl } from './url.js';

const HTTP_METHODS = new Set(['DELETE', 'GET', 'PATCH', 'POST', 'PUT']);
const URL_VALUE_RE = /https?:\/\/[^\s"'<>`)]+|\/[A-Za-z0-9][A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*/g;
const RELEVANT_KEY_RE = /(action|api|checkout|cashier|href|onclick|order|pay|purchase|subscribe|url)/i;

function normalizeMethod(value) {
  const method = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return HTTP_METHODS.has(method) ? method : null;
}

function cleanUrlLikeValue(value) {
  return value.replace(/[)'",.;]+$/g, '');
}

function collectUrls(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return [];
  }

  return Array.from(value.matchAll(URL_VALUE_RE), (match) => cleanUrlLikeValue(match[0]));
}

function explicitMethodFromArtifact(artifact) {
  const candidates = [artifact.method, artifact.formMethod];
  for (const item of artifact.values || []) {
    if (/(^|[-_])(method|httpmethod)$/i.test(item.key || '')) {
      candidates.push(item.value);
    }
  }

  for (const candidate of candidates) {
    const method = normalizeMethod(candidate);
    if (method) {
      return method;
    }
  }

  return null;
}

function postDataFromArtifact(artifact) {
  const item = (artifact.values || []).find((value) => value.key === 'formParams' && value.value);
  return item?.value || null;
}

function safeUrlFromValue(value, baseUrl) {
  const absolute = absolutizeUrl(value, baseUrl);
  if (!absolute || !isAllowedCheckoutUrl(absolute)) {
    return null;
  }
  return absolute;
}

function scoreCandidate({ absolute, key, source, index }) {
  let score = 0;
  if (isDiscoveryApiCandidate(absolute, key)) score += 40;
  if (looksLikeCheckoutUrl(absolute)) score += 30;
  if (/\/api\//i.test(new URL(absolute).pathname)) score += 20;
  if (RELEVANT_KEY_RE.test(key || '')) score += 12;
  if (/control|form|ancestor/i.test(source || '')) score += 6;
  return score - index;
}

function isDiscoveryApiCandidate(absolute, key) {
  if (!isCheckoutApiUrl(absolute)) {
    return false;
  }

  const url = new URL(absolute);
  return /\/api(\/|$)/i.test(url.pathname) || /(^|[-_])(api|endpoint)([-_]|$)/i.test(key || '');
}

export function buildRecipeFromDiscoveryArtifacts(artifacts, baseUrl) {
  const candidates = [];
  let index = 0;

  for (const artifact of artifacts || []) {
    const method = explicitMethodFromArtifact(artifact);
    const postData = postDataFromArtifact(artifact);

    for (const item of artifact.values || []) {
      const values = collectUrls(item.value);
      for (const value of values) {
        const absolute = safeUrlFromValue(value, baseUrl);
        if (!absolute) {
          index += 1;
          continue;
        }

        const api = isDiscoveryApiCandidate(absolute, item.key);
        const navigation = looksLikeCheckoutUrl(absolute);
        if (!api && !navigation) {
          index += 1;
          continue;
        }

        candidates.push({
          absolute,
          api,
          navigation,
          key: item.key,
          source: item.source,
          method,
          postData,
          score: scoreCandidate({ absolute, key: item.key, source: item.source, index })
        });
        index += 1;
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const apiCandidate = candidates.find((candidate) => candidate.api);
  if (apiCandidate) {
    return {
      type: 'api',
      url: apiCandidate.absolute,
      method: apiCandidate.method || 'POST',
      headers: apiCandidate.postData ? { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {},
      postData: apiCandidate.postData,
      capturedAt: Date.now(),
      source: 'disabled-control-discovery'
    };
  }

  const navigationCandidate = candidates.find((candidate) => candidate.navigation);
  if (navigationCandidate) {
    return {
      type: 'navigation',
      url: navigationCandidate.absolute,
      capturedAt: Date.now(),
      source: 'disabled-control-discovery'
    };
  }

  return null;
}

export function recipeDetail(recipe) {
  if (!recipe) {
    return '';
  }
  return recipe.type === 'api' ? `${recipe.method} ${recipe.url}` : `导航 ${recipe.url}`;
}
