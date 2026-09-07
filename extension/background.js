const DEFAULT_COST_URL =
  'https://mcsaetherruntime-eus.us-ia106.gateway.prod.island.powerapps.com/v1/cost';
const COST_PATH_RE = /\/v[0-9]+\/cost(\?|$)/i;
const WATCHED_URLS = [
  '*://*.powerapps.com/*',
  '*://*.powerplatform.com/*',
  '*://*.microsoft.com/*'
];
const HISTORY_MAX = 500;
const REFRESH_ALARM = 'cost-refresh';

function decodeJwtExp(token) {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const exp = JSON.parse(json).exp;
    return typeof exp === 'number' ? exp * 1000 : null;
  } catch {
    return null;
  }
}

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!COST_PATH_RE.test(details.url)) return;

    const header = (details.requestHeaders || []).find(
      (h) => h.name.toLowerCase() === 'authorization'
    );
    if (!header || !header.value) return;

    const token = header.value.replace(/^\s*Bearer\s+/i, '').trim();
    if (!token) return;

    chrome.storage.local.set({
      token,
      costUrl: details.url,
      tokenCapturedAt: Date.now(),
      tokenExpiresAt: decodeJwtExp(token)
    });
  },
  { urls: WATCHED_URLS },
  ['requestHeaders', 'extraHeaders']
);

async function getState() {
  return chrome.storage.local.get([
    'token',
    'costUrl',
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
  if (!token) {
    return { ok: false, reason: 'no-token' };
  }

  const url = costUrl || DEFAULT_COST_URL;
  let response;
  try {
    response = await fetch(url, {
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
  if (area === 'local' && changes.token?.newValue && !changes.lastCost) {
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
