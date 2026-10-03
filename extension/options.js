const DEFAULTS = {
  enabled: true,
  autoClick: true,
  groqKey: '',
  cerebrasKey: '',
  groqModel: 'openai/gpt-oss-20b',
  cerebrasModel: 'gpt-oss-120b',
  timeoutMs: 2500,
  mode: 'normal',
  godUnlocked: false,
  godHash: '',
  normalDelayMs: 2000,
  normalJitterMs: 500,
};
const $ = (id) => document.getElementById(id);

$('chev').innerHTML = ICONS.chevron;
wireKeyToggle($('groqKey'), $('toggleGroq'));
wireKeyToggle($('cerebrasKey'), $('toggleCerebras'));

// ---------- "Saved" confirmation ----------
let savedTimer;
function flashSaved() {
  const el = $('saved');
  el.classList.add('show');
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => el.classList.remove('show'), 1600);
}
async function save(patch) {
  await chrome.storage.local.set(patch);
  flashSaved();
}

// ---------- load ----------
async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  $('groqKey').value = s.groqKey;
  $('cerebrasKey').value = s.cerebrasKey;
  $('groqModel').value = s.groqModel;
  $('cerebrasModel').value = s.cerebrasModel;
  $('timeoutMs').value = s.timeoutMs;
  $('normalDelayMs').value = s.normalDelayMs;
  $('normalJitterMs').value = s.normalJitterMs;
  paintSpeed(s);
  paintGodStatus();
  $('enabled').setAttribute('aria-checked', String(s.enabled));
  $('modeClick').checked = s.autoClick;
  $('modeShow').checked = !s.autoClick;

  try {
    const cmd = (await chrome.commands.getAll()).find(c => c.name === 'toggle-solver');
    $('shortcut').textContent = cmd?.shortcut || 'Not set';
  } catch (_) { /* keep default */ }
}

// ---------- keys: save + validate inline ----------
function wireKey(inputId, statusId, provider, storageKey, emptyHtml) {
  const input = $(inputId);
  const status = $(statusId);
  let last = null;

  async function commit() {
    const key = input.value.trim();
    if (key === last) return;
    last = key;
    await save({ [storageKey]: key });
    if (!key) { status.className = 'status info'; status.innerHTML = emptyHtml; return; }
    setStatus(status, 'info', 'Checking…');
    const res = await validateKey(provider, key);
    if (input.value.trim() !== key) return; // user kept typing
    setStatus(status, res?.ok ? 'ok' : 'error', res?.ok ? 'Key works.' : (res?.message || 'Couldn’t check the key.'));
  }

  input.addEventListener('change', commit);
  input.addEventListener('paste', () => setTimeout(commit, 0));
}

wireKey('groqKey', 'groqStatus', 'groq', 'groqKey',
  'Free at <a href="https://console.groq.com/keys" target="_blank" rel="noopener">console.groq.com</a>');
wireKey('cerebrasKey', 'cerebrasStatus', 'cerebras', 'cerebrasKey',
  'Asked at the same time as Groq. The faster answer wins.');

// ---------- behaviour ----------
$('enabled').addEventListener('click', (e) => {
  const next = e.currentTarget.getAttribute('aria-checked') !== 'true';
  e.currentTarget.setAttribute('aria-checked', String(next));
  save({ enabled: next });
});
$('mode').addEventListener('change', (e) => save({ autoClick: e.target.value === 'click' }));
$('changeShortcut').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});

// ---------- speed / god mode ----------
function paintSpeed(s) {
  const god = s.mode === 'god' && s.godUnlocked;
  $('speedNormal').checked = !god;
  $('speedGod').checked = god;
  $('speedGod').disabled = !s.godUnlocked;
  $('lockGod').hidden = !s.godUnlocked;
  $('modeHelp').textContent = s.godUnlocked
    ? `Normal waits about ${(s.normalDelayMs / 1000).toFixed(1)} s before clicking. God mode clicks straight away.`
    : `Normal waits about ${(s.normalDelayMs / 1000).toFixed(1)} s before clicking. Unlock god mode from the toolbar popup.`;
}

$('speed').addEventListener('change', (e) => save({ mode: e.target.value }));

// set / change / remove the password, no file editing needed
wireKeyToggle($('godPass'), $('toggleGodPass'));

$('setGodBtn').addEventListener('click', () => {
  const form = $('godForm');
  form.hidden = !form.hidden;
  $('godStatusMsg').textContent = '';
  if (!form.hidden) $('godPass').focus();
});

$('godForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await chrome.runtime.sendMessage({ type: 'setGodPassword', password: $('godPass').value });
  $('godPass').value = '';
  if (res?.ok) {
    $('godForm').hidden = true;
    setStatus($('godStatusMsg'), 'ok', 'Password saved. God mode is unlocked on this machine.');
    load();
  } else {
    setStatus($('godStatusMsg'), 'error', res?.message || 'Couldn’t save that.');
  }
});

$('removeGod').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'clearGodPassword' });
  $('godForm').hidden = true;
  setStatus($('godStatusMsg'), 'info', 'Password removed. God mode is locked.');
  load();
});

$('lockGod').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'lockGod' });
  flashSaved();
  load();
});

async function paintGodStatus() {
  const res = await chrome.runtime.sendMessage({ type: 'godStatus' }).catch(() => null);
  const set = Boolean(res?.configured);
  const baked = set && res.source === 'config';
  $('setGodBtn').hidden = baked;               // a baked-in password can't be replaced from here
  $('setGodBtn').textContent = set ? 'Change password' : 'Set password';
  $('removeGod').hidden = !(set && !baked);
  if (baked) $('godForm').hidden = true;
  $('godHelp').textContent = baked
    ? 'Built into this copy of the extension and can’t be changed here.'
    : set
      ? 'Only a salted hash is stored. The password itself is never saved.'
      : 'No password yet. Set one and god mode unlocks on this machine.';
}

// ---------- advanced ----------
$('groqModel').addEventListener('change', (e) => save({ groqModel: e.target.value.trim() || DEFAULTS.groqModel }));
$('cerebrasModel').addEventListener('change', (e) => save({ cerebrasModel: e.target.value.trim() || DEFAULTS.cerebrasModel }));
$('timeoutMs').addEventListener('change', (e) => {
  const v = Math.max(500, parseInt(e.target.value, 10) || DEFAULTS.timeoutMs);
  e.target.value = v;
  save({ timeoutMs: v });
});

// ---------- test ----------
$('runTest').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const out = $('testResults');
  btn.disabled = true;
  out.innerHTML = '<p class="status info"><span>Testing…</span></p>';
  const { results } = await chrome.runtime.sendMessage({ type: 'test' });
  btn.disabled = false;
  out.innerHTML = '';
  for (const r of results) {
    const p = document.createElement('p');
    setStatus(p, r.ok ? 'ok' : 'error', `${r.label}: ${r.detail}`);
    out.appendChild(p);
  }
});

$('normalDelayMs').addEventListener('change', (e) => {
  const v = Math.max(0, parseInt(e.target.value, 10) || DEFAULTS.normalDelayMs);
  e.target.value = v;
  save({ normalDelayMs: v }).then(load);
});
$('normalJitterMs').addEventListener('change', (e) => {
  const v = Math.max(0, parseInt(e.target.value, 10) || 0);
  e.target.value = v;
  save({ normalJitterMs: v });
});

// keep in sync with the popup / shortcut
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  if (ch.enabled) $('enabled').setAttribute('aria-checked', String(ch.enabled.newValue));
  if (ch.autoClick) { $('modeClick').checked = ch.autoClick.newValue; $('modeShow').checked = !ch.autoClick.newValue; }
  if (ch.mode || ch.godUnlocked) load();
});

load();
