// Menti Solver - background service worker.
// Makes the API calls (content scripts can't call Groq/Cerebras directly because of CORS)
// and races the configured providers so the fastest valid answer wins.

const DEFAULTS = {
  groqKey: '',
  cerebrasKey: '',
  groqModel: 'openai/gpt-oss-20b',
  cerebrasModel: 'gpt-oss-120b',
  timeoutMs: 2500,
  autoClick: true,
};

const SYSTEM = 'You answer multiple-choice quiz questions. Output only the option number.';
const noReasoning = new Set(); // providers whose model rejected reasoning_effort

async function getSettings() {
  return { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

function providersFrom(s) {
  return [
    { name: 'groq', base: 'https://api.groq.com/openai/v1', key: s.groqKey.trim(), model: s.groqModel.trim() },
    { name: 'cerebras', base: 'https://api.cerebras.ai/v1', key: s.cerebrasKey.trim(), model: s.cerebrasModel.trim() },
  ].filter(p => p.key);
}

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
    if (!res.ok) throw new Error(`${p.name} HTTP ${res.status}: ${(await res.text()).slice(0, 150)}`);

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '';
    const n = parseInt((content.match(/\d+/) || [])[0], 10);
    if (n >= 1 && n <= options.length) return { n, provider: p.name };
    throw new Error(`${p.name} bad reply: ${content.slice(0, 80)}`);
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`${p.name} timeout`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function solve(question, options) {
  const s = await getSettings();
  const providers = providersFrom(s);
  if (!providers.length) throw new Error('No API key set. Click the extension icon to add one.');

  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await Promise.any(providers.map(p => callProvider(p, question, options, s.timeoutMs)));
    } catch (e) {
      lastErr = e;
    }
  }
  const msgs = lastErr?.errors ? lastErr.errors.map(e => e.message) : [String(lastErr)];
  throw new Error(msgs.join(' | '));
}

// Opens the TLS connection early so the first real question doesn't pay for the handshake.
async function warmup() {
  const providers = providersFrom(await getSettings());
  for (const p of providers) {
    fetch(`${p.base}/models`, { headers: { Authorization: `Bearer ${p.key}` } }).catch(() => {});
  }
  return providers.map(p => p.name);
}

async function testProviders() {
  const s = await getSettings();
  const providers = providersFrom(s);
  if (!providers.length) return [{ name: '-', ok: false, detail: 'No API key saved' }];
  const q = 'What is 7 x 8?';
  const opts = ['54', '56', '58', '64'];
  return Promise.all(providers.map(async p => {
    const t0 = performance.now();
    try {
      const { n } = await callProvider(p, q, opts, Math.max(s.timeoutMs, 5000));
      const ms = Math.round(performance.now() - t0);
      return { name: p.name, ok: n === 2, detail: n === 2 ? `correct in ${ms} ms` : `answered ${opts[n - 1]} (wrong) in ${ms} ms` };
    } catch (e) {
      return { name: p.name, ok: false, detail: e.message };
    }
  }));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'solve') {
    solve(msg.question, msg.options)
      .then(r => sendResponse({ ok: true, ...r }))
      .catch(e => sendResponse({ ok: false, error: e.message || String(e) }));
    return true;
  }
  if (msg.type === 'warmup') {
    warmup().then(providers => sendResponse({ providers }));
    return true;
  }
  if (msg.type === 'test') {
    testProviders().then(results => sendResponse({ results }));
    return true;
  }
  if (msg.type === 'ping') {
    sendResponse({ ok: true });
  }
  return false;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
