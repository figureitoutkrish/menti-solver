// Menti Solver - background service worker.
// API calls (content scripts can't call Groq/Cerebras directly because of CORS),
// provider race, key validation, toolbar badge, keyboard shortcut, first-run setup.

const DEFAULTS = {
  enabled: true,
  autoClick: true,
  groqKey: '',
  cerebrasKey: '',
  groqModel: 'openai/gpt-oss-20b',
  cerebrasModel: 'gpt-oss-120b',
  timeoutMs: 2500,
};

const PROVIDERS = {
  groq: { label: 'Groq', base: 'https://api.groq.com/openai/v1' },
  cerebras: { label: 'Cerebras', base: 'https://api.cerebras.ai/v1' },
};

const SYSTEM = 'You answer multiple-choice quiz questions. Output only the option number.';
const noReasoning = new Set(); // providers whose model rejected reasoning_effort

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

function activeProviders(s) {
  return [
    { name: 'groq', key: s.groqKey.trim(), model: s.groqModel.trim() },
    { name: 'cerebras', key: s.cerebrasKey.trim(), model: s.cerebrasModel.trim() },
  ].filter(p => p.key).map(p => ({ ...p, ...PROVIDERS[p.name] }));
}

// ---------- plain-language errors ----------
class FriendlyError extends Error {}

function httpError(label, status) {
  if (status === 401 || status === 403) return new FriendlyError(`${label} key isn't valid. Check it in Settings.`);
  if (status === 402) return new FriendlyError(`${label} needs billing on this account. Remove the ${label} key in Settings.`);
  if (status === 404) return new FriendlyError(`${label} doesn't offer that model any more. Pick another in Settings > Advanced.`);
  if (status === 429) return new FriendlyError(`${label} is rate-limiting you. Wait a few seconds.`);
  if (status >= 500) return new FriendlyError(`${label} is having problems right now.`);
  return new FriendlyError(`${label} returned an error (HTTP ${status}).`);
}

// ---------- answering ----------
function buildPrompt(question, options) {
  return `Question: ${question || '(not shown)'}\nOptions:\n` +
    options.map((t, i) => `${i + 1}. ${t}`).join('\n') +
    '\n\nReply with ONLY the number of the correct option.';
}

async function callProvider(p, question, options, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = {
      model: p.model,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: buildPrompt(question, options) },
      ],
      temperature: 0,
      max_tokens: 512,
    };
    if (!noReasoning.has(p.name)) body.reasoning_effort = 'low';

    const post = () => fetch(`${p.base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    let res = await post();
    if (res.status === 400 && body.reasoning_effort) {
      noReasoning.add(p.name);
      delete body.reasoning_effort;
      res = await post();
    }
    if (!res.ok) throw httpError(p.label, res.status);

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const n = parseInt((content.match(/\d+/) || [])[0], 10);
    if (n >= 1 && n <= options.length) return { n, provider: p.name };
    throw new FriendlyError(`${p.label} gave an answer that isn't one of the options.`);
  } catch (e) {
    if (e.name === 'AbortError') throw new FriendlyError(`${p.label} took too long to answer.`);
    if (e instanceof FriendlyError) throw e;
    throw new FriendlyError(`Couldn't reach ${p.label}. Check your internet connection.`);
  } finally {
    clearTimeout(timer);
  }
}

async function solve(question, options) {
  const s = await getSettings();
  const providers = activeProviders(s);
  if (!providers.length) throw new FriendlyError('Add your Groq key in the Menti Solver popup to start.');

  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await Promise.any(providers.map(p => callProvider(p, question, options, s.timeoutMs)));
    } catch (e) {
      last = e;
    }
  }
  const msgs = [...new Set((last?.errors || [last]).map(e => e?.message).filter(Boolean))];
  throw new FriendlyError(msgs[0] || 'Couldn\'t get an answer.');
}

// ---------- key validation ----------
async function validateKey(provider, key) {
  const p = PROVIDERS[provider];
  if (!p) return { ok: false, message: 'Unknown provider.' };
  if (!key) return { ok: false, message: 'Paste a key first.' };
  try {
    const res = await fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${key}` } });
    if (res.ok) return { ok: true };
    return { ok: false, message: httpError(p.label, res.status).message };
  } catch (_) {
    return { ok: false, message: `Couldn't reach ${p.label}. Check your internet connection.` };
  }
}

async function testProviders() {
  const s = await getSettings();
  const providers = activeProviders(s);
  if (!providers.length) return [{ label: 'Setup', ok: false, detail: 'No API key saved yet.' }];
  const opts = ['54', '56', '58', '64'];
  return Promise.all(providers.map(async p => {
    const t0 = performance.now();
    try {
      const { n } = await callProvider(p, 'What is 7 x 8?', opts, Math.max(s.timeoutMs, 5000));
      const ms = Math.round(performance.now() - t0);
      return { label: p.label, ok: n === 2, detail: n === 2 ? `correct in ${ms} ms` : `answered ${opts[n - 1]}, which is wrong (${ms} ms)` };
    } catch (e) {
      return { label: p.label, ok: false, detail: e.message };
    }
  }));
}

// Opens the TLS connection early so the first real question doesn't pay for the handshake.
async function warmup() {
  const providers = activeProviders(await getSettings());
  for (const p of providers) {
    fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${p.key}` } }).catch(() => {});
  }
}

// ---------- toolbar badge ----------
async function refreshBadge() {
  const s = await getSettings();
  const hasKey = Boolean(s.groqKey || s.cerebrasKey);
  let text = '', color = '#8E8E93', title = 'Menti Solver';
  if (!hasKey) { text = '!'; color = '#FF9F0A'; title = 'Menti Solver: add an API key to start'; }
  else if (s.enabled) { text = 'ON'; color = '#0071E3'; title = 'Menti Solver: on'; }
  else { text = 'OFF'; color = '#8E8E93'; title = 'Menti Solver: off'; }
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: '#FFFFFF' });
  await chrome.action.setTitle({ title });
}

// ---------- events ----------
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  const current = await chrome.storage.local.get(Object.keys(DEFAULTS));
  await chrome.storage.local.set({ ...DEFAULTS, ...current }); // fill in any missing defaults
  if (reason === 'install') chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
  refreshBadge();
});
chrome.runtime.onStartup.addListener(refreshBadge);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.enabled || changes.groqKey || changes.cerebrasKey)) refreshBadge();
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-solver') return;
  const { enabled } = await getSettings();
  chrome.storage.local.set({ enabled: !enabled });
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'solve') {
    const t0 = performance.now();
    solve(msg.question, msg.options)
      .then(r => {
        const ms = Math.round(performance.now() - t0);
        chrome.storage.local.set({
          lastAnswer: { question: msg.question, answer: msg.options[r.n - 1], ms: msg.detectedAt ? Math.round(Date.now() - msg.detectedAt) : ms, provider: r.provider, at: Date.now() },
        });
        sendResponse({ ok: true, ...r });
      })
      .catch(e => {
        chrome.storage.local.set({ lastAnswer: { question: msg.question, error: e.message, at: Date.now() } });
        sendResponse({ ok: false, error: e.message || String(e) });
      });
    return true;
  }
  if (msg.type === 'warmup') { warmup(); sendResponse({ ok: true }); return false; }
  if (msg.type === 'validateKey') { validateKey(msg.provider, msg.key.trim()).then(sendResponse); return true; }
  if (msg.type === 'test') { testProviders().then(results => sendResponse({ results })); return true; }
  if (msg.type === 'ping') { sendResponse({ ok: true }); return false; }
  return false;
});
