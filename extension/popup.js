const DEFAULTS = { enabled: true, autoClick: true, groqKey: '', cerebrasKey: '', lastAnswer: null };
const $ = (id) => document.getElementById(id);
const MENTI = /^https:\/\/(www\.)?menti\.com\//;

let state = { ...DEFAULTS };
let onMenti = false;

const ICON_ALERT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/></svg>';

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function ago(ts) {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : 'earlier';
}

function render() {
  const hasKey = Boolean(state.groqKey || state.cerebrasKey);

  // hero
  const sw = $('enabled');
  sw.setAttribute('aria-checked', String(state.enabled));
  $('heroTitle').textContent = state.enabled ? 'On' : 'Off';
  document.querySelector('.hero').dataset.state = state.enabled ? 'on' : 'off';
  $('heroSub').textContent =
    !hasKey ? 'Needs an API key before it can answer' :
    !state.enabled ? 'Quizzes won’t be answered' :
    onMenti ? 'Watching this quiz' :
    'Starts on its own when you open a Menti quiz';

  // setup callout
  $('setup').hidden = hasKey;

  // mode
  $('modeClick').checked = state.autoClick;
  $('modeShow').checked = !state.autoClick;
  $('mode').disabled = !state.enabled;

  // last answer
  const a = state.lastAnswer;
  const card = $('lastCard');
  if (!a) {
    card.innerHTML = '<p class="last-empty">Nothing yet. Answers from your next quiz show up here.</p>';
  } else if (a.error) {
    card.innerHTML = `<p class="last-error">${ICON_ALERT}<span>${esc(a.error)}</span></p>` +
      (a.question ? `<p class="last-question">${esc(a.question)}</p>` : '');
  } else {
    card.innerHTML =
      `<p class="last-answer">${esc(a.answer)}</p>` +
      `<p class="last-question">${esc(a.question || 'Question text not found')}</p>` +
      `<div class="last-meta"><span class="${a.ms < 1000 ? 'fast' : ''}">${a.ms} ms</span>` +
      `<span>${a.provider === 'cerebras' ? 'Cerebras' : 'Groq'}</span><span>${ago(a.at)}</span></div>`;
  }
}

async function init() {
  state = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    onMenti = Boolean(tab?.url && MENTI.test(tab.url));
  } catch (_) { onMenti = false; }

  try {
    const cmds = await chrome.commands.getAll();
    const cmd = cmds.find(c => c.name === 'toggle-solver');
    $('shortcut').textContent = cmd?.shortcut || 'Not set';
  } catch (_) { /* keep default text */ }

  render();
}

$('enabled').addEventListener('click', () => {
  state.enabled = !state.enabled;
  render(); // instant feedback, storage write follows
  chrome.storage.local.set({ enabled: state.enabled });
});

$('mode').addEventListener('change', (e) => {
  state.autoClick = e.target.value === 'click';
  chrome.storage.local.set({ autoClick: state.autoClick });
});

$('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('openSetup').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  let touched = false;
  for (const k of Object.keys(DEFAULTS)) {
    if (changes[k]) { state[k] = changes[k].newValue ?? DEFAULTS[k]; touched = true; }
  }
  if (touched) render();
});

init();
