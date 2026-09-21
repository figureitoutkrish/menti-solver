// Menti Solver - page script for the Python edition.
// Injected by menti_solver.py into every page. On menti.com it detects the question +
// options, hands them to Python via window.__mentiFound(), and clicks the answer.

(() => {
  'use strict';
  if (window.top !== window) return;
  if (!/(^|\.)menti\.com$/.test(location.hostname)) return;
  if (window.__mentiSolverLoaded) return;
  window.__mentiSolverLoaded = true;

  const CFG = window.__MENTI_CFG || { autoClick: true, providers: [] };

  function start() {

  // ---------------- config ----------------
  const MIN_OPTION_AREA = 1500; // px^2 - quiz options are big tap targets
  const MAX_FAILURES = 2;       // give up on a question after this many failed attempts
  const UI_WORDS = /^(menu|leave|join|submit|next|back|close|continue|report|language|english|skip|help|share|cancel|settings|log in|sign up|reactions?|open q&a)$/i;

  // ---------------- state ----------------
  let paused = false;
  let busyKey = null;
  const autoClick = CFG.autoClick !== false;
  const handled = new Set();
  const failures = new Map();

  // ---------------- overlay ----------------
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: 2147483647,
    background: 'rgba(0,0,0,0.82)', color: '#fff', font: '12px/1.4 -apple-system, system-ui, sans-serif',
    padding: '8px 10px', borderRadius: '8px', maxWidth: '320px', pointerEvents: 'none',
  });
  document.body.appendChild(box);
  const show = (html) => { box.innerHTML = html; };
  const esc = (s) => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

  // ---------------- DOM helpers ----------------
  const textOf = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();
  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0.05;
  }

  function findOptions() {
    const SEL = 'button,[role="button"],[role="radio"],[role="option"],[role="checkbox"],label,input[type="radio"],input[type="checkbox"]';
    let c = [...document.querySelectorAll(SEL)].filter(el => !box.contains(el));
    c = c.map(el => {
      if (el.tagName !== 'INPUT') return el;
      return el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el;
    });
    c = [...new Set(c)].filter(el => {
      if (!visible(el) || el.disabled) return false;
      const t = textOf(el);
      return t.length >= 1 && t.length <= 200 && !UI_WORDS.test(t) && area(el) >= MIN_OPTION_AREA;
    });
    c = c.filter(el => !c.some(o => o !== el && el.contains(o)));

    for (let depth = 1; depth <= 3; depth++) {
      const groups = new Map();
      for (const el of c) {
        let a = el;
        for (let i = 0; i < depth && a; i++) a = a.parentElement;
        if (!a) continue;
        if (!groups.has(a)) groups.set(a, []);
        groups.get(a).push(el);
      }
      let best = null, bestArea = 0;
      for (const g of groups.values()) {
        if (g.length < 2 || g.length > 8) continue;
        const total = g.reduce((s, el) => s + area(el), 0);
        if (total > bestArea) { best = g; bestArea = total; }
      }
      if (best) return best;
    }
    return null;
  }

  function findQuestion(opts) {
    const els = [...document.querySelectorAll('h1,h2,h3,h4,[role="heading"],legend,p')]
      .filter(el => !box.contains(el) && visible(el) && !opts.some(o => o.contains(el) || el.contains(o)));
    let best = null, bestSize = 0;
    for (const el of els) {
      const t = textOf(el);
      if (t.length < 3 || t.length > 400) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (fs > bestSize || (fs === bestSize && t.length > textOf(best).length)) { best = el; bestSize = fs; }
    }
    return textOf(best);
  }

  // ---------------- clicking ----------------
  function clickEl(el) {
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const fire = (Type, name, extra = {}) => {
      try { el.dispatchEvent(new Type(name, { ...o, ...extra })); } catch (_) { /* el.click() still runs */ }
    };
    fire(PointerEvent, 'pointerdown', { pointerType: 'mouse', isPrimary: true });
    fire(MouseEvent, 'mousedown');
    fire(PointerEvent, 'pointerup', { pointerType: 'mouse', isPrimary: true });
    fire(MouseEvent, 'mouseup');
    el.click();
  }

  function trySubmit() {
    const btn = [...document.querySelectorAll('button,[role="button"]')].find(b =>
      !box.contains(b) && visible(b) && !b.disabled && /^(submit|vote|send|submit answer|confirm)$/i.test(textOf(b)));
    if (btn) clickEl(btn);
  }

  function clickAnswer(opts, n, answer) {
    let el = opts[n - 1];
    if (!el || !el.isConnected) el = (findOptions() || []).find(e => textOf(e) === answer); // page re-rendered
    if (el) { clickEl(el); setTimeout(trySubmit, 60); }
  }

  // ---------------- Python bridge ----------------
  async function ask(question, options) {
    if (typeof window.__mentiFound !== 'function') throw new Error('Python bridge missing. Restart menti_solver.py');
    const res = await window.__mentiFound({ question, options });
    if (!res || res.error) throw new Error(res?.error || 'No response from Python');
    return res;
  }

  // ---------------- main ----------------
  async function tick() {
    if (paused) return;
    const opts = findOptions();
    if (!opts) return;

    const texts = opts.map(textOf);
    const q = findQuestion(opts);
    const key = q ? `Q:${q}` : `O:${texts.join('|')}`;
    if (handled.has(key) || busyKey === key || (failures.get(key) || 0) >= MAX_FAILURES) return;

    busyKey = key;
    const t0 = performance.now();
    show(`<b>Thinking…</b><br>${esc(q)}`);

    try {
      const { n, provider } = await ask(q, texts);
      const ms = Math.round(performance.now() - t0);
      const answer = texts[n - 1];
      handled.add(key);
      console.log(`[Menti Solver] ${ms} ms (${provider}) | Q: ${q} | A: ${n}. ${answer}`);
      show(`<b>${esc(answer)}</b><br><span style="opacity:.7">${esc(q)}<br>${ms} ms · ${provider}</span>`);
      if (autoClick) clickAnswer(opts, n, answer);
    } catch (e) {
      failures.set(key, (failures.get(key) || 0) + 1);
      show(`<b>Error</b><br>${esc(e.message)}`);
      console.warn('[Menti Solver]', e);
    } finally {
      busyKey = null;
    }
  }

  let scheduled = false;
  new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; tick(); });
  }).observe(document.body, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'disabled'],
  });
  setInterval(tick, 300);

  // ---------------- hotkeys (Option on Mac, Alt on Windows) ----------------
  function dumpStructure() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script,style,svg,img,noscript,iframe,video,canvas').forEach(n => n.remove());
    const keep = /^(id|class|role|type|for|name|disabled|aria-.*|data-testid)$/;
    clone.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(a => { if (!keep.test(a.name)) el.removeAttribute(a.name); });
    });
    const opts = findOptions();
    const html = `<!-- detected options: ${opts ? opts.map(textOf).join(' | ') : 'NONE'} -->\n` +
                 `<!-- detected question: ${opts ? findQuestion(opts) : 'n/a'} -->\n` +
                 clone.outerHTML.slice(0, 30000);
    if (typeof window.__mentiDump === 'function') window.__mentiDump(html);
    show('<b>Page structure saved</b><br>python/debug_structure.html');
  }

  document.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    if (e.code === 'KeyP') {
      paused = !paused;
      show(paused ? '<b>Paused</b> (Opt+P to resume)' : '<b>Resumed</b>');
    } else if (e.code === 'KeyD') {
      dumpStructure();
    }
  });

  // ---------------- start ----------------
  const p = CFG.providers || [];
  show(p.length
    ? `<b>Menti Solver ready</b> (${p.join(' + ')} via Python)<br>Opt+P pause · Opt+D save page structure`
    : '<b>No API key set</b><br>Add one to python/.env and restart');
  }

  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
