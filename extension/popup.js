const $ = (id) => document.getElementById(id);

const numberFmt = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat('fr-FR', {
  dateStyle: 'short',
  timeStyle: 'short'
});

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function ratioColor(ratio) {
  if (ratio >= 0.9) return cssVar('--danger');
  if (ratio >= 0.7) return cssVar('--warn');
  return cssVar('--ok');
}

function drawGauge(canvas, consumed, limit) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  const cx = w / 2;
  const cy = h / 2 + 12;
  const radius = Math.min(w, h) / 2 - 16;
  const thickness = 16;
  const start = Math.PI * 0.75;
  const end = Math.PI * 2.25;
  const ratio = limit > 0 ? Math.min(consumed / limit, 1) : 0;

  ctx.clearRect(0, 0, w, h);

  ctx.lineCap = 'round';
  ctx.lineWidth = thickness;
  ctx.strokeStyle = 'rgba(127,127,127,0.22)';
  ctx.beginPath();
  ctx.arc(cx, cy, radius, start, end);
  ctx.stroke();

  if (ratio > 0) {
    ctx.strokeStyle = ratioColor(ratio);
    ctx.beginPath();
    ctx.arc(cx, cy, radius, start, start + (end - start) * ratio);
    ctx.stroke();
  }

  ctx.fillStyle = cssVar('--fg');
  ctx.textAlign = 'center';
  ctx.font = '600 30px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(`${Math.round(ratio * 100)}%`, cx, cy + 6);

  ctx.fillStyle = cssVar('--muted');
  ctx.font = '12px "Segoe UI", system-ui, sans-serif';
  ctx.fillText(`${numberFmt.format(consumed)} / ${numberFmt.format(limit)}`, cx, cy + 26);
}

function drawTrend(canvas, history) {
  const ctx = canvas.getContext('2d');
  const { width: w, height: h } = canvas;
  ctx.clearRect(0, 0, w, h);

  const points = history.filter((p) => typeof p.userConsumed === 'number');
  if (points.length < 2) {
    ctx.fillStyle = cssVar('--muted');
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Historique en cours de constitution...', w / 2, h / 2);
    return;
  }

  const pad = { l: 6, r: 6, t: 10, b: 14 };
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = Math.max(t1 - t0, 1);
  const limit = points[points.length - 1].userLimit || 0;
  const maxValue = Math.max(limit || 0, ...points.map((p) => p.userConsumed)) || 1;

  const x = (t) => pad.l + ((t - t0) / span) * (w - pad.l - pad.r);
  const y = (v) => h - pad.b - (v / maxValue) * (h - pad.t - pad.b);

  if (limit > 0) {
    ctx.strokeStyle = cssVar('--danger');
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, y(limit));
    ctx.lineTo(w - pad.r, y(limit));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const accent = cssVar('--accent');
  const gradient = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  gradient.addColorStop(0, 'rgba(15,108,189,0.35)');
  gradient.addColorStop(1, 'rgba(15,108,189,0.02)');

  ctx.beginPath();
  points.forEach((p, i) => {
    const px = x(p.t);
    const py = y(p.userConsumed);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = accent;
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.lineTo(x(t1), h - pad.b);
  ctx.lineTo(x(t0), h - pad.b);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.fillStyle = accent;
  const last = points[points.length - 1];
  ctx.beginPath();
  ctx.arc(x(last.t), y(last.userConsumed), 3, 0, Math.PI * 2);
  ctx.fill();
}

function formatDate(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : dateFmt.format(date);
}

function formatCountdown(target) {
  const ms = new Date(target).getTime() - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  return days > 0 ? ` (dans ${days} j)` : ` (dans ${hours} h)`;
}

function setBar(el, ratio) {
  el.style.width = `${Math.min(Math.max(ratio, 0), 1) * 100}%`;
  el.style.background = ratioColor(ratio);
}

function renderCost(cost, state) {
  const user = cost.user || {};
  const policy = cost.policy || {};

  drawGauge($('userGauge'), user.consumed || 0, user.limit || 0);
  drawGauge($('policyGauge'), policy.consumed || 0, policy.limit || 0);

  $('userDetail').textContent = `${numberFmt.format(user.consumed || 0)} credits consommes`;
  $('policyName').textContent = policy.policyName || 'Policy';
  $('policyDetail').textContent = `${numberFmt.format(policy.consumed || 0)} credits consommes`;

  const userRatio = user.limit ? user.consumed / user.limit : 0;
  const policyRatio = policy.limit ? policy.consumed / policy.limit : 0;
  setBar($('userBar'), userRatio);
  setBar($('policyBar'), policyRatio);
  $('userRemaining').textContent = numberFmt.format(
    Math.max((user.limit || 0) - (user.consumed || 0), 0)
  );
  $('policyRemaining').textContent = numberFmt.format(
    Math.max((policy.limit || 0) - (policy.consumed || 0), 0)
  );

  $('asOfDate').textContent = formatDate(cost.asOfDate);
  $('resetOn').textContent = formatDate(cost.resetOn) + formatCountdown(cost.resetOn);
  $('lastFetch').textContent = formatDate(state.lastFetchAt);

  const expiresAt = state.tokenExpiresAt;
  if (!state.token) {
    $('tokenState').textContent = 'absent';
  } else if (expiresAt) {
    const minutes = Math.round((expiresAt - Date.now()) / 60000);
    $('tokenState').textContent =
      minutes > 0
        ? `valide ${minutes} min (${state.tokenSource || 'capture'})`
        : 'expire - rechargez la page Copilot';
  } else {
    $('tokenState').textContent = `capture ${formatDate(state.tokenCapturedAt)}`;
  }
  $('endpoint').textContent = state.costUrl || '-';

  const history = state.history || [];
  drawTrend($('trend'), history);
  $('trendRange').textContent =
    history.length > 1
      ? `${formatDate(history[0].t)} -> ${formatDate(history[history.length - 1].t)}`
      : '';
}

function showError(message) {
  const el = $('error');
  el.textContent = message || '';
  el.classList.toggle('hidden', !message);
}

async function render() {
  const state = await chrome.runtime.sendMessage({ type: 'state' });
  const hasToken = Boolean(state?.token);
  const cost = state?.lastCost;

  $('onboarding').classList.toggle('hidden', hasToken);
  $('dashboard').classList.toggle('hidden', !(hasToken && cost));
  $('refresh').classList.toggle('hidden', !hasToken);

  if (hasToken && cost) renderCost(cost, state);
  showError(hasToken ? state.lastError : null);
}

async function refresh() {
  const button = $('refresh');
  button.classList.add('spinning');
  const result = await chrome.runtime.sendMessage({ type: 'refresh' });
  button.classList.remove('spinning');

  if (result?.reason === 'expired-token') {
    showError('Jeton expire. Rechargez la page Microsoft 365 Copilot.');
  } else if (result && !result.ok && result.reason !== 'no-token') {
    showError(result.message || 'Echec de la recuperation.');
  }
  await render();
}

$('refresh').addEventListener('click', refresh);
$('manualSubmit').addEventListener('click', async () => {
  const token = $('manualToken').value.trim();
  const url = $('manualUrl').value.trim();
  if (!token) {
    showError('Collez un jeton.');
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: 'set-token', token, url });
  if (result?.reason === 'invalid-token') {
    showError('Jeton invalide ou expire.');
  } else if (result && !result.ok) {
    showError(result.message || 'Echec de la recuperation.');
  } else {
    showError(null);
    $('manualToken').value = '';
  }
  await render();
});
$('clear').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clear' });
  await render();
});

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') render();
});

(async () => {
  await render();
  const state = await chrome.runtime.sendMessage({ type: 'state' });
  if (state?.token) await refresh();
})();
