const DEFAULTS = {
  groqKey: '',
  cerebrasKey: '',
  groqModel: 'openai/gpt-oss-20b',
  cerebrasModel: 'gpt-oss-120b',
  timeoutMs: 2500,
  autoClick: true,
};

const $ = (id) => document.getElementById(id);
const status = (text) => { $('status').textContent = text; };

async function load() {
  const s = await chrome.storage.local.get(DEFAULTS);
  for (const k of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[k] === 'boolean') $(k).checked = s[k];
    else $(k).value = s[k];
  }
}

async function save() {
  const s = {};
  for (const k of Object.keys(DEFAULTS)) {
    if (typeof DEFAULTS[k] === 'boolean') s[k] = $(k).checked;
    else if (typeof DEFAULTS[k] === 'number') s[k] = Math.max(500, parseInt($(k).value, 10) || DEFAULTS[k]);
    else s[k] = $(k).value.trim() || DEFAULTS[k];
  }
  await chrome.storage.local.set(s);
  status('Saved. Refresh any open menti.com tab.');
}

$('save').addEventListener('click', save);

$('test').addEventListener('click', async () => {
  await save();
  status('Testing…');
  const { results } = await chrome.runtime.sendMessage({ type: 'test' });
  status(results.map(r => `${r.ok ? '✅' : '❌'} ${r.name}: ${r.detail}`).join('\n'));
});

load();
