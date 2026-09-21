// Shared helpers for the setup and settings pages.

const ICONS = {
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5M12 16.5h.01"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Show/hide toggle for a password-style key field. */
function wireKeyToggle(input, button) {
  const paint = () => {
    const shown = input.type === 'text';
    button.innerHTML = shown ? ICONS.eyeOff : ICONS.eye;
    button.setAttribute('aria-label', shown ? 'Hide key' : 'Show key');
    button.setAttribute('aria-pressed', String(shown));
  };
  button.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; paint(); });
  paint();
}

/** kind: 'ok' | 'error' | 'info' */
function setStatus(el, kind, text) {
  el.className = `status ${kind}`;
  const icon = kind === 'ok' ? ICONS.check : kind === 'error' ? ICONS.alert : '';
  el.innerHTML = `${icon}<span>${esc(text)}</span>`;
}

function validateKey(provider, key) {
  return chrome.runtime.sendMessage({ type: 'validateKey', provider, key });
}
