const $ = (id) => document.getElementById(id);
const input = $('groqKey');
const status = $('keyStatus');
const checkBtn = $('checkKey');

document.querySelectorAll('.step-mark').forEach(m => m.insertAdjacentHTML('beforeend', ICONS.check));
wireKeyToggle(input, $('toggleKey'));

function markDone(...ids) { ids.forEach(id => $(id).classList.add('done')); }

$('getKey').addEventListener('click', () => markDone('step1'));

async function check() {
  const key = input.value.trim();
  if (!key) {
    setStatus(status, 'error', 'Paste your key first.');
    input.focus();
    return;
  }
  checkBtn.disabled = true;
  setStatus(status, 'info', 'Checking with Groq…');
  const res = await validateKey('groq', key);
  checkBtn.disabled = false;

  if (res?.ok) {
    await chrome.storage.local.set({ groqKey: key, enabled: true });
    setStatus(status, 'ok', 'Key works and is saved. You’re ready.');
    markDone('step1', 'step2');
  } else {
    setStatus(status, 'error', res?.message || 'Couldn’t check the key. Try again.');
  }
}

checkBtn.addEventListener('click', check);
input.addEventListener('keydown', (e) => { if (e.key === 'Enter') check(); });

// Returning users: show that a key is already saved
chrome.storage.local.get({ groqKey: '' }).then(({ groqKey }) => {
  if (groqKey) {
    input.value = groqKey;
    setStatus(status, 'ok', 'A key is already saved. Check it again if you changed it.');
    markDone('step1', 'step2');
  }
});
