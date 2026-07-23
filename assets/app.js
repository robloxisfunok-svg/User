'use strict';

const MAX_BATCH = 25;
const CHECK_DELAY_MS = 5000;
const STORAGE = {
  webhook: 'discordChecker.webhook',
  available: 'discordChecker.available',
  autoExport: 'discordChecker.autoExport',
  sendWebhook: 'discordChecker.sendWebhook'
};

const $ = (id) => document.getElementById(id);
const state = {
  running: false,
  stopRequested: false,
  records: [],
  runAvailable: new Set(),
  savedAvailable: new Set()
};

let toastTimer = null;

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function setMessage(element, message, tone = 'muted') {
  element.textContent = message;
  element.className = `message ${tone}-text`;
}

function setBadge(element, text, tone = 'muted') {
  element.textContent = text;
  element.className = `badge ${tone}`;
}

function normalizeUsername(value) {
  return String(value || '').trim().toLowerCase().replace(/^@+/, '');
}

function normalizeAffix(value) {
  return normalizeUsername(value).replace(/[^a-z0-9._]/g, '').replace(/\.{2,}/g, '.');
}

function isValidUsername(value) {
  return /^[a-z0-9._]{2,32}$/.test(value) && !value.includes('..');
}

function randomTwoDigits() {
  if (window.crypto && window.crypto.getRandomValues) {
    const value = new Uint32Array(1);
    window.crypto.getRandomValues(value);
    return String(value[0] % 100).padStart(2, '0');
  }
  return String(Math.floor(Math.random() * 100)).padStart(2, '0');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function parseInputLines() {
  return $('words').value
    .split(/\r?\n|,/)
    .map((line) => normalizeUsername(line))
    .filter(Boolean);
}

function updateInputCount() {
  const count = parseInputLines().length;
  $('inputCount').textContent = `${count} line${count === 1 ? '' : 's'}`;
}

function prepareCandidates() {
  const lines = parseInputLines();
  const mode = $('mode').value;
  const prefix = normalizeAffix($('prefix').value);
  const suffix = normalizeAffix($('suffix').value);
  const requestedLimit = Number.parseInt($('limit').value, 10);
  const limit = Math.max(1, Math.min(MAX_BATCH, Number.isFinite(requestedLimit) ? requestedLimit : 15));
  $('limit').value = String(limit);

  const candidates = [];
  const seen = new Set();
  let skipped = 0;

  for (const line of lines) {
    let candidate = line;
    if (mode === 'prefix') candidate = `${prefix}${line}`;
    if (mode === 'suffix') candidate = `${line}${suffix}`;
    if (mode === 'both') candidate = `${prefix}${line}${suffix}`;
    if (mode === 'number') candidate = `${line}${randomTwoDigits()}`;
    candidate = candidate.slice(0, 32);

    if (!isValidUsername(candidate)) {
      skipped += 1;
      continue;
    }
    if (seen.has(candidate)) continue;

    seen.add(candidate);
    candidates.push(candidate);
    if (candidates.length >= limit) break;
  }

  state.records = candidates.map((username) => ({
    username,
    status: 'pending',
    message: ''
  }));
  state.runAvailable = new Set();
  renderResults();

  if (!lines.length) {
    setMessage($('runMessage'), 'Paste names or upload a .txt file first.', 'warn');
  } else if (!candidates.length) {
    setMessage($('runMessage'), 'No valid Discord usernames were found in that input.', 'warn');
  } else {
    const skippedText = skipped ? ` ${skipped} invalid line${skipped === 1 ? '' : 's'} skipped.` : '';
    setMessage($('runMessage'), `${candidates.length} candidate${candidates.length === 1 ? '' : 's'} ready.${skippedText}`, 'good');
  }

  return candidates;
}

function resultLabel(status) {
  return status.replaceAll('_', ' ');
}

function renderResults() {
  const results = $('results');
  const total = state.records.length;
  const available = state.records.filter((record) => record.status === 'available').length;
  const taken = state.records.filter((record) => record.status === 'taken').length;
  const completed = state.records.filter((record) => !['pending', 'checking'].includes(record.status)).length;
  const other = Math.max(0, completed - available - taken);

  $('statTotal').textContent = String(total);
  $('statAvailable').textContent = String(available);
  $('statTaken').textContent = String(taken);
  $('statOther').textContent = String(other);
  $('progressBar').style.width = total ? `${Math.round((completed / total) * 100)}%` : '0%';

  if (!total) {
    results.innerHTML = '<div class="empty-state">Upload or paste a list, then press Start checking.</div>';
    $('progressText').textContent = 'No active batch';
    return;
  }

  results.innerHTML = state.records.map((record) => {
    const detail = record.message
      ? `<div class="result-detail">${escapeHtml(record.message)}</div>`
      : '';
    return `<div class="result-row">
      <div class="result-name">@${escapeHtml(record.username)}</div>
      <div class="result-status status-${escapeHtml(record.status)}">${escapeHtml(resultLabel(record.status))}</div>
      ${detail}
    </div>`;
  }).join('');
}

function loadSavedAvailable() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE.available) || '[]');
    if (Array.isArray(parsed)) {
      state.savedAvailable = new Set(parsed.filter(isValidUsername));
    }
  } catch (_) {
    state.savedAvailable = new Set();
  }
  updateSavedCount();
}

function saveAvailable(username) {
  if (!isValidUsername(username)) return;
  state.savedAvailable.add(username);
  try {
    localStorage.setItem(STORAGE.available, JSON.stringify([...state.savedAvailable].sort()));
  } catch (_) {
    showToast('The name was found, but browser storage is unavailable.');
  }
  updateSavedCount();
}

function updateSavedCount() {
  $('savedCount').textContent = String(state.savedAvailable.size);
}

function downloadTextFile(filename, lines) {
  const cleanLines = [...new Set(lines)].filter(Boolean).sort();
  if (!cleanLines.length) {
    showToast('There are no available usernames to export yet.');
    return false;
  }

  const blob = new Blob([`${cleanLines.join('\n')}\n`], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  return true;
}

async function fetchJson(path, options) {
  const response = await fetch(path, options);
  let data;
  try {
    data = await response.json();
  } catch (_) {
    data = { message: 'The server returned an invalid response.' };
  }
  return { response, data };
}

async function checkUsername(username) {
  const { response, data } = await fetchJson('/api/check', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username })
  });

  return {
    status: data.status || (response.ok ? 'error' : 'error'),
    message: data.message || '',
    retryAfter: Number(data.retry_after) || 0
  };
}

function currentWebhook() {
  return $('webhookUrl').value.trim();
}

function looksLikeDiscordWebhook(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && ['discord.com', 'canary.discord.com', 'ptb.discord.com', 'discordapp.com'].includes(url.hostname.toLowerCase())
      && /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9._-]+\/?$/.test(url.pathname);
  } catch (_) {
    return false;
  }
}

function saveWebhookLocally() {
  const webhook = currentWebhook();
  if (!looksLikeDiscordWebhook(webhook)) {
    setMessage($('webhookMessage'), 'Enter a valid Discord webhook URL.', 'bad');
    setBadge($('webhookBadge'), 'Invalid', 'bad');
    return false;
  }

  localStorage.setItem(STORAGE.webhook, webhook);
  setMessage($('webhookMessage'), 'Webhook saved in this browser.', 'good');
  setBadge($('webhookBadge'), 'Saved', 'good');
  showToast('Webhook saved.');
  return true;
}

async function sendWebhookAction(action, username = '') {
  const webhookUrl = currentWebhook();
  if (!looksLikeDiscordWebhook(webhookUrl)) {
    return { ok: false, message: 'No valid webhook is saved.' };
  }

  const body = { action, webhook_url: webhookUrl };
  if (username) body.username = username;

  const { response, data } = await fetchJson('/api/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { ok: response.ok && data.ok === true, message: data.message || 'Webhook request failed.' };
}

async function testWebhook() {
  if (!saveWebhookLocally()) return;
  const button = $('testWebhook');
  button.disabled = true;
  setMessage($('webhookMessage'), 'Testing webhook…', 'muted');
  setBadge($('webhookBadge'), 'Testing', 'busy');

  try {
    const result = await sendWebhookAction('test');
    if (result.ok) {
      setMessage($('webhookMessage'), result.message, 'good');
      setBadge($('webhookBadge'), 'Working', 'good');
    } else {
      setMessage($('webhookMessage'), result.message, 'bad');
      setBadge($('webhookBadge'), 'Failed', 'bad');
    }
  } catch (_) {
    setMessage($('webhookMessage'), 'Could not test the webhook.', 'bad');
    setBadge($('webhookBadge'), 'Failed', 'bad');
  } finally {
    button.disabled = false;
  }
}

function setControlsRunning(running) {
  state.running = running;
  $('startCheck').disabled = running;
  $('stopCheck').disabled = !running;
  $('fileInput').disabled = running;
  $('sampleNames').disabled = running;
  $('clearNames').disabled = running;
  $('runBadge').className = `badge ${running ? 'busy' : 'muted'}`;
  $('runBadge').textContent = running ? 'Running' : 'Idle';
}

async function startChecking() {
  if (state.running) return;
  const candidates = prepareCandidates();
  if (!candidates.length) return;

  state.stopRequested = false;
  setControlsRunning(true);
  setMessage($('runMessage'), 'Checking usernames sequentially…', 'muted');

  for (let index = 0; index < state.records.length; index += 1) {
    if (state.stopRequested) break;

    const record = state.records[index];
    record.status = 'checking';
    record.message = '';
    $('progressText').textContent = `Checking ${index + 1} of ${state.records.length}`;
    renderResults();

    let delayAfterCheck = CHECK_DELAY_MS;
    try {
      const result = await checkUsername(record.username);
      record.status = result.status;
      record.message = result.message;

      if (result.status === 'available') {
        state.runAvailable.add(record.username);
        saveAvailable(record.username);

        if ($('sendWebhookToggle').checked && looksLikeDiscordWebhook(currentWebhook())) {
          const webhookResult = await sendWebhookAction('available', record.username);
          record.message = webhookResult.ok
            ? 'Saved and sent to webhook.'
            : `Saved. Webhook: ${webhookResult.message}`;
        } else {
          record.message = 'Saved to the browser available list.';
        }
      }

      if (result.status === 'rate_limited') {
        delayAfterCheck = Math.max(CHECK_DELAY_MS, Math.ceil(result.retryAfter * 1000));
      }
    } catch (_) {
      record.status = 'error';
      record.message = 'Network or server error.';
    }

    renderResults();

    if (!state.stopRequested && index < state.records.length - 1) {
      let seconds = Math.ceil(delayAfterCheck / 1000);
      while (seconds > 0 && !state.stopRequested) {
        $('progressText').textContent = `Next check in ${seconds}s`;
        await sleep(1000);
        seconds -= 1;
      }
    }
  }

  setControlsRunning(false);
  const stopped = state.stopRequested;
  $('progressText').textContent = stopped ? 'Batch stopped' : 'Batch finished';
  setBadge($('runBadge'), stopped ? 'Stopped' : 'Finished', stopped ? 'bad' : 'good');

  if (!stopped && $('autoExportToggle').checked && state.runAvailable.size > 0) {
    downloadTextFile('available_usernames.txt', state.savedAvailable);
    setMessage($('runMessage'), `Finished. ${state.runAvailable.size} available name${state.runAvailable.size === 1 ? '' : 's'} found; export started.`, 'good');
  } else if (stopped) {
    setMessage($('runMessage'), 'Stopped. Completed results remain saved.', 'warn');
  } else {
    setMessage($('runMessage'), `Finished. ${state.runAvailable.size} available name${state.runAvailable.size === 1 ? '' : 's'} found.`, state.runAvailable.size ? 'good' : 'muted');
  }
}

function loadPreferences() {
  const savedWebhook = localStorage.getItem(STORAGE.webhook) || '';
  $('webhookUrl').value = savedWebhook;
  if (savedWebhook) {
    setBadge($('webhookBadge'), 'Saved', 'good');
    setMessage($('webhookMessage'), 'Webhook loaded from this browser. You can edit or test it.', 'good');
  }

  const autoExport = localStorage.getItem(STORAGE.autoExport);
  const sendWebhook = localStorage.getItem(STORAGE.sendWebhook);
  if (autoExport !== null) $('autoExportToggle').checked = autoExport === 'true';
  if (sendWebhook !== null) $('sendWebhookToggle').checked = sendWebhook === 'true';
}

$('words').addEventListener('input', updateInputCount);

$('fileInput').addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (file.size > 1_000_000) {
    showToast('Use a text file smaller than 1 MB.');
    event.target.value = '';
    return;
  }
  try {
    $('words').value = await file.text();
    updateInputCount();
    setMessage($('runMessage'), `${file.name} loaded.`, 'good');
  } catch (_) {
    setMessage($('runMessage'), 'Could not read that text file.', 'bad');
  }
  event.target.value = '';
});

$('sampleNames').addEventListener('click', () => {
  $('words').value = ['nova', 'vertex', 'ember', 'orbit', 'cipher', 'vanta', 'lunar', 'echo', 'pixel', 'drift', 'zenith', 'onyx', 'frost', 'nexus', 'atlas'].join('\n');
  updateInputCount();
});

$('clearNames').addEventListener('click', () => {
  $('words').value = '';
  state.records = [];
  state.runAvailable = new Set();
  updateInputCount();
  renderResults();
  setMessage($('runMessage'), 'Input cleared.', 'muted');
});

$('startCheck').addEventListener('click', startChecking);
$('stopCheck').addEventListener('click', () => {
  state.stopRequested = true;
  $('stopCheck').disabled = true;
  setMessage($('runMessage'), 'Stopping after the current request…', 'warn');
});

$('saveWebhook').addEventListener('click', saveWebhookLocally);
$('testWebhook').addEventListener('click', testWebhook);
$('removeWebhook').addEventListener('click', () => {
  localStorage.removeItem(STORAGE.webhook);
  $('webhookUrl').value = '';
  setBadge($('webhookBadge'), 'Not saved', 'muted');
  setMessage($('webhookMessage'), 'Webhook removed from this browser.', 'muted');
  showToast('Webhook removed.');
});

$('toggleWebhook').addEventListener('click', () => {
  const input = $('webhookUrl');
  const revealing = input.type === 'password';
  input.type = revealing ? 'text' : 'password';
  $('toggleWebhook').textContent = revealing ? 'Hide' : 'Show';
});

$('autoExportToggle').addEventListener('change', () => {
  localStorage.setItem(STORAGE.autoExport, String($('autoExportToggle').checked));
});
$('sendWebhookToggle').addEventListener('change', () => {
  localStorage.setItem(STORAGE.sendWebhook, String($('sendWebhookToggle').checked));
});

$('downloadSaved').addEventListener('click', () => {
  downloadTextFile('available_usernames.txt', state.savedAvailable);
});

$('clearSaved').addEventListener('click', () => {
  if (!state.savedAvailable.size) {
    showToast('There are no saved usernames to clear.');
    return;
  }
  if (!window.confirm('Clear all saved available usernames from this browser?')) return;
  state.savedAvailable.clear();
  localStorage.removeItem(STORAGE.available);
  updateSavedCount();
  showToast('Saved available usernames cleared.');
});

loadPreferences();
loadSavedAvailable();
updateInputCount();
renderResults();
