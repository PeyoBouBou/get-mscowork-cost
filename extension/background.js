const COST_PATH = '/v1/cost';
const COST_PATH_RE = /\/v[0-9]+\/cost(\?|$)/i;
// L'hote du runtime Copilot n'est pas statique : il depend du tenant et de la
// region (mcsaetherruntime-eus.us-ia106..., mcsaetherruntime-cus.us-ia302...).
// Il est donc toujours decouvert dynamiquement ; ce fallback ne sert que si
// aucune decouverte n'a encore abouti.
const FALLBACK_HOST = 'mcsaetherruntime-eus.us-ia106.gateway.prod.island.powerapps.com';
const DEFAULT_COST_URL = `https://${FALLBACK_HOST}${COST_PATH}`;
// Hotes qui portent un jeton utilisable pour /v1/cost (runtime Copilot).
const TOKEN_HOST_RE = /(^|\.)gateway\.prod\.island\.powerapps\.com$/i;
// Meme motif, applique a du texte libre (JSON de configuration, storage, ...).
// Utilise par les fonctions injectees dans la page (copie locale du motif).
// Audience attendue pour un jeton du runtime Copilot (scoring des candidats).
const RUNTIME_AUDIENCE = 'https://api.powerplatform.com/';
const WATCHED_URLS = ['*://*.powerapps.com/*'];
const HISTORY_MAX = 500;
const ENDPOINTS_MAX = 20;
const REFRESH_ALARM = 'cost-refresh';
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

// --- Registre des endpoints decouverts ---------------------------------------

// Serialise les ecritures : plusieurs requetes peuvent etre observees en meme temps.
let endpointQueue = Promise.resolve();

function costUrlFor(host, observedUrl) {
  if (observedUrl) {
    try {
      const parsed = new URL(observedUrl);
      if (COST_PATH_RE.test(parsed.pathname)) return parsed.origin + parsed.pathname;
    } catch {
      /* URL inutilisable */
    }
  }
  return `https://${host}${COST_PATH}`;
}

function rememberEndpoint(host, source, observedUrl) {
  if (!host || !TOKEN_HOST_RE.test(host)) return endpointQueue;
  endpointQueue = endpointQueue
    .then(async () => {
      const { endpoints = [] } = await chrome.storage.local.get('endpoints');
      const url = costUrlFor(host, observedUrl);
      const existing = endpoints.find((e) => e.host === host);
      if (existing) {
        existing.seenAt = Date.now();
        if (COST_PATH_RE.test(new URL(url).pathname)) existing.url = url;
      } else {
        endpoints.push({
          host,
          url,
          source: source || 'inconnu',
          seenAt: Date.now(),
          firstSeenAt: Date.now(),
          lastOkAt: null
        });
      }
      const trimmed = endpoints
        .sort((a, b) => (b.lastOkAt || 0) - (a.lastOkAt || 0) || (b.seenAt || 0) - (a.seenAt || 0))
        .slice(0, ENDPOINTS_MAX);
      await chrome.storage.local.set({ endpoints: trimmed });
    })
    .catch(() => {});
  return endpointQueue;
}

function markEndpointOk(url) {
  endpointQueue = endpointQueue
    .then(async () => {
      const host = new URL(url).host;
      const { endpoints = [] } = await chrome.storage.local.get('endpoints');
      const entry = endpoints.find((e) => e.host === host);
      if (entry) {
        entry.lastOkAt = Date.now();
        entry.url = url;
      } else {
        endpoints.push({
          host,
          url,
          source: 'valide a l\'appel',
          seenAt: Date.now(),
          firstSeenAt: Date.now(),
          lastOkAt: Date.now()
        });
      }
      await chrome.storage.local.set({ endpoints: endpoints.slice(0, ENDPOINTS_MAX) });
    })
    .catch(() => {});
  return endpointQueue;
}

// Liste ordonnee des URL a essayer : endpoint actif, puis endpoints decouverts
// (les plus recemment valides d'abord), puis fallback.
async function candidateCostUrls() {
  const { costUrl, endpoints = [] } = await chrome.storage.local.get(['costUrl', 'endpoints']);
  const ranked = endpoints
    .slice()
    .sort((a, b) => (b.lastOkAt || 0) - (a.lastOkAt || 0) || (b.seenAt || 0) - (a.seenAt || 0))
    .map((e) => e.url);
  return Array.from(new Set([costUrl, ...ranked, DEFAULT_COST_URL].filter(Boolean)));
}

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

async function storeToken(rawToken, url, source, force = false) {
  const token = String(rawToken || '')
    .replace(/^\s*Bearer\s+/i, '')
    .trim();
  if (!token || !JWT_RE.test(token)) return false;

  const expiresAt = decodeJwtExp(token);
  if (expiresAt && expiresAt <= Date.now()) return false;

  const current = await chrome.storage.local.get(['token', 'tokenExpiresAt']);
  if (current.token === token) return false;
  // Ne pas remplacer un jeton valide par un jeton qui expire plus tot.
  if (
    !force &&
    current.token &&
    current.tokenExpiresAt &&
    expiresAt &&
    expiresAt < current.tokenExpiresAt
  ) {
    return false;
  }

  const parsed = new URL(url);
  const costUrl = costUrlFor(parsed.host, url);
  await rememberEndpoint(parsed.host, source === 'manuel' ? 'saisie manuelle' : 'trafic reseau', url);

  await chrome.storage.local.set({
    token,
    costUrl,
    endpointSource: source === 'manuel' ? 'saisie manuelle' : 'trafic reseau',
    endpointUpdatedAt: Date.now(),
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
    const isRuntime = TOKEN_HOST_RE.test(host);
    if (!isRuntime && !COST_PATH_RE.test(details.url)) return;

    // Decouverte de l'endpoint : tout appel vers le runtime revele l'hote du
    // tenant, meme si la requete ne porte pas d'en-tete Authorization.
    if (isRuntime) rememberEndpoint(host, 'trafic reseau', details.url);

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
    'endpoints',
    'endpointSource',
    'endpointUpdatedAt',
    'endpointsScannedAt',
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

async function fetchCost(allowDiscovery = true) {
  const { token } = await getState();
  if (!token) return { ok: false, reason: 'no-token' };

  const urls = await candidateCostUrls();
  let lastFailure = null;

  for (const url of urls) {
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        cache: 'no-store'
      });
    } catch (error) {
      // Hote injoignable (region differente) : on tente le candidat suivant.
      lastFailure = { reason: 'network', message: error?.message || 'Requete impossible' };
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      // Probleme de jeton et non d'endpoint : inutile d'essayer les autres hotes.
      await chrome.storage.local.remove(['token', 'tokenCapturedAt', 'tokenExpiresAt']);
      await chrome.action.setBadgeText({ text: '' });
      await chrome.storage.local.set({ lastError: `HTTP ${response.status} - jeton expire` });
      return { ok: false, reason: 'expired-token', status: response.status };
    }

    if (!response.ok) {
      lastFailure = {
        reason: 'http',
        message: `HTTP ${response.status} ${response.statusText}`,
        status: response.status
      };
      continue;
    }

    let cost;
    try {
      cost = await response.json();
    } catch {
      lastFailure = { reason: 'http', message: 'Reponse illisible' };
      continue;
    }

    await markEndpointOk(url);
    await chrome.storage.local.set({
      costUrl: url,
      lastCost: cost,
      lastFetchAt: Date.now(),
      lastError: null
    });
    await pushHistory(cost);
    await updateBadge(cost);
    return { ok: true, cost, costUrl: url };
  }

  // Aucun endpoint connu ne repond : nouvelle decouverte puis second essai.
  if (allowDiscovery) {
    const discovery = await discoverEndpoints();
    if (discovery.added) return fetchCost(false);
  }

  const message = lastFailure?.message || 'Aucun endpoint /v1/cost joignable';
  await chrome.storage.local.set({ lastError: message });
  return { ok: false, reason: lastFailure?.reason || 'no-endpoint', message };
}

// --- Decouverte autonome de l'endpoint ---------------------------------------

const SCAN_MATCHES = [
  '*://*.cloud.microsoft/*',
  '*://*.office.com/*',
  '*://copilot.microsoft.com/*',
  '*://*.powerapps.com/*'
];

// Execute dans la page : releve les hotes runtime deja contactes ou configures.
function scanPageForEndpoints() {
  const RUNTIME_HOST = /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.gateway\.prod\.island\.powerapps\.com/gi;
  const hosts = new Set();

  const scanString = (value) => {
    if (typeof value !== 'string' || value.length < 20) return;
    const found = value.match(RUNTIME_HOST);
    if (found) found.forEach((h) => hosts.add(h.toLowerCase()));
  };

  try {
    for (const entry of performance.getEntriesByType('resource')) scanString(entry.name);
  } catch {
    /* API indisponible */
  }

  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        scanString(key);
        scanString(store.getItem(key));
      }
    } catch {
      /* stockage inaccessible */
    }
  }

  return Array.from(hosts);
}

// Interroge les onglets Copilot ouverts pour trouver l'hote runtime du tenant.
async function discoverEndpoints() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: SCAN_MATCHES });
  } catch {
    tabs = [];
  }
  if (!tabs.length) return { ok: false, reason: 'no-tab', added: 0, hosts: [] };

  const before = (await chrome.storage.local.get('endpoints')).endpoints || [];
  const known = new Set(before.map((e) => e.host));
  const hosts = new Set();

  for (const tab of tabs) {
    let results = [];
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: scanPageForEndpoints
      });
    } catch {
      continue;
    }
    for (const frame of results) (frame.result || []).forEach((h) => hosts.add(h));
  }

  for (const host of hosts) await rememberEndpoint(host, 'decouverte page');

  const added = Array.from(hosts).filter((h) => !known.has(h)).length;
  await chrome.storage.local.set({ endpointsScannedAt: Date.now() });
  return { ok: hosts.size > 0, hosts: Array.from(hosts), added, tabs: tabs.length };
}

// --- Recherche du jeton dans la memoire de l'onglet ---------------------------

// Execute dans la page : collecte les JWT et les hotes runtime vus.
function scanPageForTokens() {
  const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
  const RUNTIME_HOST = /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.gateway\.prod\.island\.powerapps\.com/gi;
  const tokens = new Set();
  const hosts = new Set();

  const scanString = (value) => {
    if (typeof value !== 'string' || value.length < 20) return;
    const foundHosts = value.match(RUNTIME_HOST);
    if (foundHosts) foundHosts.forEach((h) => hosts.add(h.toLowerCase()));
    if (value.length < 40) return;
    const found = value.match(JWT);
    if (found) found.forEach((t) => tokens.add(t));
  };

  const scanValue = (value, depth = 0) => {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string') return scanString(value);
    if (typeof value !== 'object') return;
    for (const item of Array.isArray(value) ? value : Object.values(value)) {
      scanValue(item, depth + 1);
    }
  };

  for (const store of [window.localStorage, window.sessionStorage]) {
    try {
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i);
        scanString(store.getItem(key));
      }
    } catch {
      /* stockage inaccessible */
    }
  }

  try {
    for (const entry of performance.getEntriesByType('resource')) {
      const host = new URL(entry.name, location.href).host;
      if (/gateway\.prod\.island\.powerapps\.com$/i.test(host)) hosts.add(host);
    }
  } catch {
    /* ignore */
  }

  const idb = (async () => {
    if (!indexedDB.databases) return;
    const dbs = await indexedDB.databases();
    for (const info of dbs.slice(0, 10)) {
      if (!info.name) continue;
      const db = await new Promise((resolve) => {
        const req = indexedDB.open(info.name);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      });
      if (!db) continue;
      for (const storeName of Array.from(db.objectStoreNames).slice(0, 10)) {
        try {
          const rows = await new Promise((resolve) => {
            const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
          });
          rows.slice(0, 200).forEach((row) => scanValue(row));
        } catch {
          /* store illisible */
        }
      }
      db.close();
    }
  })();

  return Promise.race([idb, new Promise((r) => setTimeout(r, 2500))]).then(() => ({
    tokens: Array.from(tokens),
    hosts: Array.from(hosts)
  }));
}

function rankCandidates(tokens) {
  const now = Date.now();
  return tokens
    .map((token) => {
      let claims = {};
      try {
        const padded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        claims = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4)));
      } catch {
        return null;
      }
      const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : null;
      if (exp && exp <= now) return null;
      const aud = String(claims.aud || '');
      const score =
        (aud === RUNTIME_AUDIENCE ? 100 : 0) +
        (/island|powerapps|copilot/i.test(aud) ? 20 : 0) +
        (/access_as_user/.test(String(claims.scp || '')) ? 5 : 0);
      return { token, exp, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || (b.exp || 0) - (a.exp || 0))
    .slice(0, 12);
}

async function scanForToken() {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: SCAN_MATCHES });
  } catch {
    tabs = [];
  }
  if (!tabs.length) return { ok: false, reason: 'no-tab' };

  const tokens = new Set();
  const hosts = new Set();
  for (const tab of tabs) {
    let results = [];
    try {
      results = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: scanPageForTokens
      });
    } catch {
      continue;
    }
    for (const frame of results) {
      (frame.result?.tokens || []).forEach((t) => tokens.add(t));
      (frame.result?.hosts || []).forEach((h) => hosts.add(h));
    }
  }

  if (!tokens.size) return { ok: false, reason: 'no-candidate', tabs: tabs.length };

  for (const host of hosts) await rememberEndpoint(host, 'scan memoire');
  const urls = await candidateCostUrls();

  const candidates = rankCandidates(Array.from(tokens));
  if (!candidates.length) return { ok: false, reason: 'no-candidate', tabs: tabs.length };

  for (const candidate of candidates) {
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${candidate.token}`, Accept: 'application/json' },
          cache: 'no-store'
        });
        if (!response.ok) continue;
        const cost = await response.json();
        await storeToken(candidate.token, url, 'scan memoire', true);
        await markEndpointOk(url);
        await chrome.storage.local.set({
          lastCost: cost,
          lastFetchAt: Date.now(),
          lastError: null
        });
        await pushHistory(cost);
        await updateBadge(cost);
        return { ok: true, cost, tried: candidates.length };
      } catch {
        /* candidat suivant */
      }
    }
  }

  return { ok: false, reason: 'no-valid-token', tried: candidates.length };
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
  if (message?.type === 'captured') {
    storeToken(message.token, message.url || DEFAULT_COST_URL, 'hook page');
    return false;
  }
  if (message?.type === 'endpoint-seen') {
    try {
      rememberEndpoint(new URL(message.url).host, 'hook page', message.url);
    } catch {
      /* URL invalide */
    }
    return false;
  }
  if (message?.type === 'discover') {
    (async () => {
      const discovery = await discoverEndpoints();
      const fetched = await fetchCost(false);
      sendResponse({ ...discovery, fetched });
    })();
    return true;
  }
  if (message?.type === 'scan') {
    scanForToken().then(sendResponse);
    return true;
  }
  if (message?.type === 'set-token') {
    (async () => {
      const stored = await storeToken(message.token, message.url || DEFAULT_COST_URL, 'manuel', true);
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
  discoverEndpoints();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(REFRESH_ALARM, { periodInMinutes: 15 });
  discoverEndpoints();
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === REFRESH_ALARM) fetchCost();
});
