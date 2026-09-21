// Menti Solver - content script (runs inside menti.com).
// Detects the question + options, asks the background worker, clicks the answer,
// and shows status in a glass pill that expands into a card.

(() => {
  'use strict';
  if (window.top !== window) return;

  // When the extension is reloaded/updated, the background re-injects this script into open
  // menti.com tabs. The newest copy takes over: older copies (whose connection to the
  // extension is broken) hear this event and shut themselves down.
  const INSTANCE = Math.random().toString(36).slice(2);
  document.dispatchEvent(new CustomEvent('menti-solver:takeover', { detail: INSTANCE }));
  document.querySelectorAll('menti-solver-ui').forEach(n => n.remove()); // clears UI left by very old versions

  // ---------------- config ----------------
  const MIN_OPTION_AREA = 1500;   // px^2 - quiz options are big tap targets
  const MAX_FAILURES = 2;         // give up on a question after this many failed attempts
  const FLASH_MS = 3500;          // how long the card stays open after an answer
  const UI_WORDS = /^(menu|leave|join|submit|next|back|close|continue|report|language|english|skip|help|share|cancel|settings|log in|sign up|reactions?|open q&a)$/i;

  // ---------------- state ----------------
  let enabled = true;
  let autoClick = true;
  let hasKey = true;
  let busyKey = null;
  const handled = new Set();
  const failures = new Map();

  // ================= overlay (shadow DOM, isolated from Menti's CSS) =================
  const host = document.createElement('menti-solver-ui');
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      :host { all: initial; position: fixed; right: 16px; bottom: 16px; z-index: 2147483647; }
      * { box-sizing: border-box; margin: 0; }
      .wrap {
        --glass: rgba(242, 242, 247, 0.74); --text: #1D1D1F; --text-2: #5E5E63; --edge: rgba(255,255,255,0.6);
        --accent: #007AFF; --danger: #D70015; --fill: rgba(120,120,128,0.28);
        --ease: cubic-bezier(0.2, 0.9, 0.25, 1);
        display: flex; flex-direction: column; align-items: flex-end; gap: 8px;
        font: 13px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
        color: var(--text); -webkit-font-smoothing: antialiased;
        pointer-events: none; /* only the visible pill/card take the mouse, never the empty area */
      }
      @media (prefers-color-scheme: dark) {
        .wrap { --glass: rgba(44, 44, 46, 0.72); --text: #F5F5F7; --text-2: #AEAEB2; --edge: rgba(255,255,255,0.12);
                --accent: #0A84FF; --danger: #FF6961; --fill: rgba(120,120,128,0.4); }
      }
      .glass {
        background: var(--glass);
        -webkit-backdrop-filter: blur(24px) saturate(180%); backdrop-filter: blur(24px) saturate(180%);
        box-shadow: inset 0 0.5px 0 var(--edge), 0 8px 28px rgba(0,0,0,0.22), 0 1px 3px rgba(0,0,0,0.12);
      }

      /* ---------- pill ---------- */
      .pill {
        display: flex; align-items: center; gap: 8px; max-width: 280px; height: 36px;
        padding: 0 14px 0 10px; border-radius: 18px; cursor: default; pointer-events: auto;
        transition: transform 280ms var(--ease), opacity 280ms var(--ease), filter 280ms var(--ease);
      }
      .ind { width: 18px; height: 18px; flex: none; display: grid; place-items: center; }
      .ind svg { width: 18px; height: 18px; }
      .label { font-weight: 600; letter-spacing: -0.005em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .pms { color: var(--text-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-2); }
      .ring { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--fill); border-top-color: var(--accent); animation: spin 700ms linear infinite; }
      .hollow { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--text-2); }
      @keyframes spin { to { transform: rotate(360deg); } }

      /* ---------- card ---------- */
      .card {
        position: relative; width: 300px; padding: 14px 16px 12px; border-radius: 16px;
        transform-origin: bottom right;
        opacity: 0; transform: translateY(6px) scale(0.97); filter: blur(4px);
        visibility: hidden; pointer-events: none;
        transition: opacity 260ms var(--ease), transform 300ms var(--ease), filter 260ms var(--ease), visibility 0s linear 300ms;
      }
      .wrap:hover .card, .wrap.open .card, .wrap:focus-within .card {
        opacity: 1; transform: none; filter: none; visibility: visible; pointer-events: auto;
        transition: opacity 260ms var(--ease), transform 300ms var(--ease), filter 260ms var(--ease), visibility 0s;
      }
      /* invisible bridge over the gap so moving from pill to card keeps it open */
      .card::after { content: ""; position: absolute; left: 0; right: 0; bottom: -8px; height: 8px; }
      .c-q { color: var(--text-2); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
      .c-a { margin-top: 6px; font-size: 17px; line-height: 1.3; font-weight: 600; letter-spacing: -0.01em; overflow-wrap: anywhere; }
      .c-a.err { color: var(--danger); font-size: 15px; }
      .c-meta { display: flex; gap: 12px; margin-top: 8px; color: var(--text-2); font-size: 12px; font-variant-numeric: tabular-nums; }
      .c-meta:empty { display: none; }
      .c-row { display: flex; align-items: center; justify-content: space-between; margin-top: 12px; padding-top: 10px; border-top: 0.5px solid var(--fill); }
      .c-row span { font-weight: 500; }

      /* compact switch (same behaviour as the popup's) */
      .sw { --w: 38px; --h: 23px; position: relative; width: var(--w); height: var(--h); border: 0; padding: 0; border-radius: 999px;
            background: var(--fill); cursor: pointer; transition: background-color 220ms var(--ease); }
      .sw[aria-checked="true"] { background: var(--accent); }
      .sw .t { position: absolute; top: 2px; left: 2px; width: calc(var(--h) - 4px); height: calc(var(--h) - 4px); border-radius: 999px;
               background: #fff; box-shadow: 0 2px 6px rgba(0,0,0,0.2); transition: transform 300ms var(--ease), width 140ms var(--ease); }
      .sw[aria-checked="true"] .t { transform: translateX(calc(var(--w) - var(--h))); }
      .sw:active .t { width: calc(var(--h) + 2px); }
      .sw[aria-checked="true"]:active .t { transform: translateX(calc(var(--w) - var(--h) - 6px)); }
      .sw:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 55%, transparent); outline-offset: 2px; }

      /* hidden when switched off (after a short "Off" confirmation) */
      .wrap.gone .pill, .wrap.gone .card { opacity: 0; transform: translateY(8px) scale(0.96); filter: blur(4px); pointer-events: none; }

      .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

      @media (prefers-reduced-motion: reduce) {
        .pill, .card, .sw, .sw .t { transition-duration: 1ms !important; }
        .card { transform: none !important; filter: none !important; }
        .ring { animation: none; border-color: var(--accent); }
      }
      @media (prefers-reduced-transparency: reduce) {
        .glass { -webkit-backdrop-filter: none; backdrop-filter: none; background: #F2F2F7; }
        @media (prefers-color-scheme: dark) { .glass { background: #2C2C2E; } }
      }
      @media (prefers-contrast: more) {
        .glass { -webkit-backdrop-filter: none; backdrop-filter: none; border: 1px solid currentColor; }
      }
    </style>
    <div class="wrap" part="wrap">
      <div class="card glass">
        <p class="c-q"></p>
        <p class="c-a"></p>
        <div class="c-meta"></div>
        <div class="c-row"><span id="swl">Solver</span><button class="sw" role="switch" aria-checked="true" aria-labelledby="swl"><span class="t"></span></button></div>
      </div>
      <div class="pill glass">
        <span class="ind" aria-hidden="true"></span>
        <span class="label"></span>
        <span class="pms"></span>
      </div>
      <p class="sr" role="status" aria-live="polite"></p>
    </div>`;
  document.body.appendChild(host);

  const $ = (sel) => root.querySelector(sel);
  const ui = {
    wrap: $('.wrap'), ind: $('.ind'), label: $('.label'), pms: $('.pms'),
    q: $('.c-q'), a: $('.c-a'), meta: $('.c-meta'), sw: $('.sw'), live: $('.sr'),
  };

  const IND = {
    ready: '<span class="dot"></span>',
    thinking: '<span class="ring"></span>',
    off: '<span class="hollow"></span>',
    answered: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="var(--accent)"/><path d="M6 10.4l2.7 2.7L14.2 7.4" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    error: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="var(--danger)"/><path d="M10 5.8v5.2M10 14.2h.01" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>',
  };

  let flashTimer, goneTimer;
  function flash(ms = FLASH_MS) {
    ui.wrap.classList.add('open');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => ui.wrap.classList.remove('open'), ms);
  }

  /** Single place that updates the pill + card. */
  function setUI(state, { label = '', ms = '', question = '', answer = '', meta = [], announce = '' } = {}) {
    ui.ind.innerHTML = IND[state] || IND.ready;
    ui.label.textContent = label;
    ui.pms.textContent = ms;
    ui.q.textContent = question;
    ui.a.textContent = answer;
    ui.a.classList.toggle('err', state === 'error');
    ui.meta.replaceChildren(...meta.map(t => Object.assign(document.createElement('span'), { textContent: t })));
    ui.sw.setAttribute('aria-checked', String(enabled));
    if (announce) ui.live.textContent = announce;

    clearTimeout(goneTimer);
    ui.wrap.classList.remove('gone');
    if (state === 'off') goneTimer = setTimeout(() => ui.wrap.classList.add('gone'), 2500);
  }

  function showIdle() {
    if (!hasKey) return setUI('error', { label: 'Needs an API key', question: 'Open the Menti Solver popup in the toolbar and add your Groq key.', answer: 'Not set up yet' });
    if (!enabled) return setUI('off', { label: 'Off', question: 'Turn it back on here, from the toolbar, or with the shortcut.', answer: 'Solver is off', announce: 'Menti Solver off' });
    setUI('ready', { label: 'Ready', question: 'Waiting for the next question.', answer: 'Watching this quiz', announce: 'Menti Solver on' });
  }

  ui.sw.addEventListener('click', () => {
    if (!contextValid()) { orphaned(); return; }
    enabled = !enabled;
    ui.sw.setAttribute('aria-checked', String(enabled)); // instant feedback
    chrome.storage.local.set({ enabled }).catch(() => {});
  });

  // ================= detection =================
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
    let c = [...document.querySelectorAll(SEL)];
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
      .filter(el => visible(el) && !opts.some(o => o.contains(el) || el.contains(o)));
    let best = null, bestSize = 0;
    for (const el of els) {
      const t = textOf(el);
      if (t.length < 3 || t.length > 400) continue;
      const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (fs > bestSize || (fs === bestSize && t.length > textOf(best).length)) { best = el; bestSize = fs; }
    }
    return textOf(best);
  }

  // ================= clicking =================
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
      visible(b) && !b.disabled && /^(submit|vote|send|submit answer|confirm)$/i.test(textOf(b)));
    if (btn) clickEl(btn);
  }

  function clickAnswer(opts, n, answer) {
    let el = opts[n - 1];
    if (!el || !el.isConnected) el = (findOptions() || []).find(e => textOf(e) === answer);
    if (el) { clickEl(el); setTimeout(trySubmit, 60); }
  }

  // ================= messaging =================
  class OrphanError extends Error {}
  const contextValid = () => { try { return Boolean(chrome.runtime?.id); } catch (_) { return false; } };

  function send(msg) {
    return new Promise((resolve, reject) => {
      if (!contextValid()) return reject(new OrphanError('orphaned'));
      try {
        chrome.runtime.sendMessage(msg, res => {
          const err = chrome.runtime.lastError;
          if (err) {
            if (!contextValid() || /context invalidated|receiving end does not exist/i.test(err.message)) return reject(new OrphanError(err.message));
            return reject(new Error(err.message));
          }
          resolve(res);
        });
      } catch (_) {
        reject(new OrphanError('orphaned'));
      }
    });
  }

  // ================= shutdown =================
  let dead = false;
  const timers = [];
  let observer = null;

  function teardown({ keepUI = false } = {}) {
    if (dead) return;
    dead = true;
    observer?.disconnect();
    timers.forEach(clearInterval);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('menti-solver:takeover', onTakeover);
    if (!keepUI) host.remove();
  }

  // This copy lost its connection and nothing replaced it: stop quietly and say what to do.
  function orphaned() {
    if (dead) return;
    teardown({ keepUI: true });
    setUI('error', { label: 'Refresh this page', question: 'Menti Solver was updated while this tab was open.', answer: 'Refresh to finish updating' });
    flash(8000);
  }

  function onTakeover(e) { if (e.detail !== INSTANCE) teardown(); }
  document.addEventListener('menti-solver:takeover', onTakeover);

  // ================= main loop =================
  async function tick() {
    if (dead || !enabled || !hasKey) return;
    const opts = findOptions();
    if (!opts) return;

    const texts = opts.map(textOf);
    const q = findQuestion(opts);
    const key = q ? `Q:${q}` : `O:${texts.join('|')}`;
    if (handled.has(key) || busyKey === key || (failures.get(key) || 0) >= MAX_FAILURES) return;

    busyKey = key;
    const detectedAt = Date.now();
    const t0 = performance.now();
    setUI('thinking', { label: 'Thinking', question: q, answer: 'Finding the answer…' });

    try {
      const res = await send({ type: 'solve', question: q, options: texts, detectedAt });
      if (!res || !res.ok) throw new Error(res?.error || 'No response from the extension.');
      if (!enabled) return; // switched off while waiting

      const ms = Math.round(performance.now() - t0);
      const answer = texts[res.n - 1];
      handled.add(key);
      const clicked = autoClick;
      if (clicked) clickAnswer(opts, res.n, answer);

      setUI('answered', {
        label: answer, ms: `${ms} ms`, question: q, answer,
        meta: [`${ms} ms`, res.provider === 'cerebras' ? 'Cerebras' : 'Groq', clicked ? 'Clicked' : 'Not clicked'],
        announce: `Answer: ${answer}`,
      });
      flash();
      console.log(`[Menti Solver] ${ms} ms (${res.provider}) | Q: ${q} | A: ${res.n}. ${answer}`);
    } catch (e) {
      if (e instanceof OrphanError) { orphaned(); return; }
      failures.set(key, (failures.get(key) || 0) + 1);
      setUI('error', { label: 'Couldn’t answer', question: q, answer: e.message, announce: `Couldn't answer: ${e.message}` });
      flash(6000);
      console.info('[Menti Solver]', e.message); // shown in the card; info level keeps chrome://extensions Errors clean
    } finally {
      busyKey = null;
    }
  }

  let scheduled = false;
  observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; tick(); });
  }).observe(document.body, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'disabled'],
  });
  timers.push(setInterval(tick, 300));

  // keep the background worker (and its API connection) alive between questions
  timers.push(setInterval(() => {
    if (!enabled || dead) return;
    send({ type: 'ping' }).catch(e => { if (e instanceof OrphanError) orphaned(); });
  }, 20000));

  // ================= settings sync =================
  chrome.storage.local.get({ enabled: true, autoClick: true, groqKey: '', cerebrasKey: '' }).then(s => {
    enabled = s.enabled;
    autoClick = s.autoClick;
    hasKey = Boolean(s.groqKey || s.cerebrasKey);
    showIdle();
    if (enabled && hasKey) { send({ type: 'warmup' }).catch(() => {}); tick(); }
  });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || dead) return;
    if (ch.autoClick) autoClick = ch.autoClick.newValue;
    if (ch.groqKey || ch.cerebrasKey) {
      chrome.storage.local.get({ groqKey: '', cerebrasKey: '' }).then(s => {
        hasKey = Boolean(s.groqKey || s.cerebrasKey);
        showIdle();
      });
    }
    if (ch.enabled) {
      enabled = ch.enabled.newValue;
      showIdle();
      if (enabled) { failures.clear(); send({ type: 'warmup' }).catch(() => {}); tick(); }
    }
  });

  // ================= debug: Option/Alt+D copies the page structure =================
  function onKeydown(e) {
    if (!e.altKey || e.code !== 'KeyD') return;
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script,style,svg,img,noscript,iframe,video,canvas,menti-solver-ui').forEach(n => n.remove());
    const keep = /^(id|class|role|type|for|name|disabled|aria-.*|data-testid)$/;
    clone.querySelectorAll('*').forEach(el => [...el.attributes].forEach(a => { if (!keep.test(a.name)) el.removeAttribute(a.name); }));
    const opts = findOptions();
    const html = `<!-- detected options: ${opts ? opts.map(textOf).join(' | ') : 'NONE'} -->\n` +
                 `<!-- detected question: ${opts ? findQuestion(opts) : 'n/a'} -->\n` + clone.outerHTML.slice(0, 30000);
    navigator.clipboard.writeText(html)
      .then(() => { setUI('ready', { label: 'Page structure copied', question: 'Paste it wherever you need it.', answer: 'Copied' }); flash(2500); })
      .catch(() => console.log(html));
  }
  document.addEventListener('keydown', onKeydown);
})();
