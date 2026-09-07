const COST_PATH = '/v1/cost';
const COST_PATH_RE = /\/v[0-9]+\/cost(\?|$)/i;
const DEFAULT_COST_URL =
  'https://mcsaetherruntime-eus.us-ia106.gateway.prod.island.powerapps.com/v1/cost';
// Hotes qui portent un jeton utilisable pour /v1/cost (runtime Copilot).
const TOKEN_HOST_RE = /(^|\.)gateway\.prod\.island\.powerapps\.com$/i;
const WATCHED_URLS = ['*://*.powerapps.com/*'];
const HISTORY_MAX = 500;
const REFRESH_ALARM = 'cost-refresh';
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

function decodeJwtExp(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

async function storeToken(rawToken, url, source) {
  const token = String(rawToken || '')
    .replace(/^\s*Bearer\s+/i, '')
    .trim();
  if (!token || !JWT_RE.test(token)) return false;

  const expiresAt = decodeJwtExp(token);
  if (expiresAt && expiresAt <= Date.now()) return false;

  const current = await chrome.storage.local.get(['token', 'tokenExpiresAt']);
  if (current.token === token) return false;
  // Ne pas remplacer un jeton valide par un jeton qui expire plus tot.
  if (current.token && current.tokenExpiresAt && expiresAt && expiresAt < current.tokenExpiresAt) {
    return false;
  }

  const parsed = new URL(url);
  const costUrl = COST_PATH_RE.test(parsed.pathname)
    ? parsed.origin + parsed.pathname
    : parsed.origin + COST_PATH;

  await chrome.storage.local.set({
    token,
    costUrl,
    tokenHost: parsed.host,
    tokenSource: source,
    tokenCapturedAt: Date.now(),
    tokenExpiresAt: expiresAt
  });
  return true;
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    let host;
    try {
      host = new URL(details.url).host;
    } catch {
      return;
    }
    if (!TOKEN_HOST_RE.test(host) && !COST_PATH_RE.test(details.url)) return;

    const header = (details.requestHeaders || []).find(
      (h) => h.name.toLowerCase() === 'authorization'
    );
    if (!header || !header.value) return;

    storeToken(header.value, details.url, 'capture');
  },
  { urls: WATCHED_URLS },
  ['requestHeaders', 'extraHeaders']
);

async function getState() {
  return chrome.storage.local.get([
    'token',
    'costUrl',
    'tokenHost',
    'tokenSource',
    'tokenCapturedAt',
    'tokenExpiresAt',
    'lastCost',
    'lastFetchAt',
    'lastError',
    'history'
  ]);
}

async function pushHistory(cost) {
  const { history = [] } = await chrome.storage.local.get('history');
  const sample = {
    t: Date.now(),
    userConsumed: cost?.user?.consumed ?? null,
    userLimit: cost?.user?.limit ?? null,
    policyConsumed: cost?.policy?.consumed ?? null,
    policyLimit: cost?.policy?.limit ?? null
  };
  const last = history[history.length - 1];
  if (!last || last.userConsumed !== sample.userConsumed || sample.t - last.t > 300000) {
    history.push(sample);
  }
  await chrome.storage.local.set({ history: history.slice(-HISTORY_MAX) });
}

async function updateBadge(cost) {
  const consumed = cost?.user?.consumed;
  const limit = cost?.user?.limit;
  if (typeof consumed !== 'number' || !limit) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  const pct = Math.round((consumed / limit) * 100);
  const color = pct >= 90 ? '#d13438' : pct >= 70 ? '#f7a600' : '#107c10';
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text: `${Math.min(pct, 999)}%` });
}

async function fetchCost() {
  const { token, costUrl } = await getState();
  if (!token) return { ok: false, reason: 'no-token' };

  let response;
  try {
    response = await fetch(costUrl || DEFAULT_COST_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store'
    });
  } catch (error) {
    const message = error?.message || 'Requete impossible';
    await chrome.storage.local.set({ lastError: message });
    return { ok: false, reason: 'network', message };
  }

  if (response.status === 401 || response.status === 403) {
    await chrome.storage.local.remove(['token', 'tokenCapturedAt', 'tokenExpiresAt']);
    await chrome.action.setBadgeText({ text: '' });
    await chrome.storage.local.set({ lastError: `HTTP ${response.status} - jeton expire` });
    return { ok: false, reason: 'expired-token', status: response.status };
  }

  if (!response.ok) {
    const message = `HTTP ${response.status} ${response.statusText}`;
    await chrome.storage.local.set({ lastError: message });
    return { ok: false, reason: 'http', message, status: response.status };
  }

  const cost = await response.json();
  await chrome.storage.local.set({ lastCost: cost, lastFetchAt: Date.now(), lastError: null });
  await pushHistory(cost);
  await updateBadge(cost);
  return { ok: true, cost };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'refresh') {
    fetchCost().then(sendResponse);
    return true;
  }
  if (message?.type === 'state') {
    getState().then(sendResponse);
    return true;
  }
  if (message?.type === 'set-token') {
    (async () => {
      const stored = await storeToken(message.token, message.url || DEFAULT_COST_URL, 'manuel');
      if (!stored) {
        sendResponse({ ok: false, reason: 'invalid-token' });
        return;
      }
      sendResponse(await fetchCost());
    })();
    return true;
  }
  if (message?.type === 'clear') {
    chrome.storage.local
      .clear()
      .then(() => chrome.action.setBadgeText({ text: '' }))
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.token && changes.token.newValue) {
    fetchCost();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: 15 });
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: 15 });
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) fetchCost();
});
