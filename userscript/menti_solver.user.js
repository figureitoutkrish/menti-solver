// ==UserScript==
// @name         Menti Solver
// @namespace    krish.menti
// @version      1.1
// @description  Reads Mentimeter quiz questions/options straight from the page, asks a fast LLM, clicks the answer.
// @match        https://www.menti.com/*
// @match        https://menti.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      api.groq.com
// @connect      api.cerebras.ai
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------- config ----------------
  const GROQ_KEY = 'PASTE_YOUR_GROQ_KEY_HERE';
  const CEREBRAS_KEY = ''; // optional backup - leave empty to use Groq only

  const AUTO_CLICK = true;
  const TIMEOUT_MS = 2500;   // give up on a provider after this long
  const MIN_OPTION_AREA = 1500; // px^2 - quiz option buttons are big tap targets

  const PROVIDERS = [
    { name: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: GROQ_KEY,
      model: 'openai/gpt-oss-20b', extra: { reasoning_effort: 'low' } },
    { name: 'cerebras', url: 'https://api.cerebras.ai/v1/chat/completions', key: CEREBRAS_KEY,
      model: 'gpt-oss-120b', extra: { reasoning_effort: 'low' } },
  ].filter(p => p.key && !p.key.startsWith('PASTE'));

  // Buttons that are page UI, never quiz options
  const UI_WORDS = /^(menu|leave|join|submit|next|back|close|continue|report|language|english|skip|help|share|cancel|settings|log in|sign up|reactions?|open q&a)$/i;

  // ---------------- state ----------------
  let paused = false;
  let busyKey = null;
  const handled = new Set();

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
  show(`<b>Menti Solver v1.1 ready</b> (${PROVIDERS.map(p => p.name).join(' + ') || 'NO API KEY SET'})<br>Opt+P pause · Opt+D copy page structure`);

  // ---------------- DOM helpers ----------------
  const textOf = (el) => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();

  function visible(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && parseFloat(s.opacity) > 0.05;
  }

  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };

  function findOptions() {
    const SEL = 'button,[role="button"],[role="radio"],[role="option"],[role="checkbox"],label,input[type="radio"],input[type="checkbox"]';
    let c = [...document.querySelectorAll(SEL)].filter(el => !box.contains(el));

    // hidden radio inputs -> their visible label
    c = c.map(el => {
      if (el.tagName !== 'INPUT') return el;
      return el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)) || el;
    });
    c = [...new Set(c)].filter(el => {
      if (!visible(el) || el.disabled) return false;
      const t = textOf(el);
      return t.length >= 1 && t.length <= 200 && !UI_WORDS.test(t) && area(el) >= MIN_OPTION_AREA;
    });
    // keep innermost clickable elements
    c = c.filter(el => !c.some(o => o !== el && el.contains(o)));

    // options are siblings (or cousins): group by shared ancestor, shallowest depth first
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
      try { el.dispatchEvent(new Type(name, { ...o, ...extra })); } catch (e) { /* ignore, el.click() below still runs */ }
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

  // ---------------- AI ----------------
  function callProvider(p, question, options) {
    const prompt =
      `Question: ${question || '(not shown)'}\nOptions:\n` +
      options.map((t, i) => `${i + 1}. ${t}`).join('\n') +
      `\n\nReply with ONLY the number of the correct option.`;

    const send = (extra) => new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: p.url,
        timeout: TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
        data: JSON.stringify({
          model: p.model,
          messages: [
            { role: 'system', content: 'You answer multiple-choice quiz questions. Output only the option number.' },
            { role: 'user', content: prompt },
          ],
          temperature: 0,
          max_tokens: 512,
          ...extra,
        }),
        onload: (res) => {
          if (res.status === 400 && Object.keys(extra).length) return reject({ retryPlain: true });
          if (res.status !== 200) return reject(new Error(`${p.name} HTTP ${res.status}: ${res.responseText.slice(0, 150)}`));
          try {
            const content = JSON.parse(res.responseText).choices[0].message.content || '';
            const n = parseInt((content.match(/\d+/) || [])[0], 10);
            if (n >= 1 && n <= options.length) resolve({ n, provider: p.name });
            else reject(new Error(`${p.name} bad reply: ${content.slice(0, 80)}`));
          } catch (e) { reject(e); }
        },
        onerror: () => reject(new Error(`${p.name} network error`)),
        ontimeout: () => reject(new Error(`${p.name} timeout`)),
      });
    });

    return send(p.extra).catch(err => {
      if (err && err.retryPlain) { p.extra = {}; return send({}); } // model doesn't support reasoning_effort
      throw err;
    });
  }

  async function askAll(question, options) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await Promise.any(PROVIDERS.map(p => callProvider(p, question, options)));
      } catch (e) {
        console.warn('[Menti Solver] all providers failed', e.errors || e);
      }
    }
    throw new Error('all providers failed twice');
  }

  // ---------------- main ----------------
  async function tick() {
    if (paused || !PROVIDERS.length) return;
    const opts = findOptions();
    if (!opts) return;

    const texts = opts.map(textOf);
    const q = findQuestion(opts);
    const key = q ? `Q:${q}` : `O:${texts.join('|')}`;
    if (handled.has(key) || busyKey === key) return;

    busyKey = key;
    const t0 = performance.now();
    show(`<b>Thinking…</b><br>${esc(q)}`);

    try {
      const { n, provider } = await askAll(q, texts);
      const ms = Math.round(performance.now() - t0);
      const answer = texts[n - 1];
      handled.add(key);

      console.log(`[Menti Solver] ${ms} ms (${provider}) | Q: ${q} | A: ${n}. ${answer}`);
      show(`<b>${esc(answer)}</b><br><span style="opacity:.7">${esc(q)}<br>${ms} ms · ${provider}</span>`);

      if (AUTO_CLICK) {
        let el = opts[n - 1];
        if (!el.isConnected) el = (findOptions() || []).find(e => textOf(e) === answer); // page re-rendered
        if (el) { clickEl(el); setTimeout(trySubmit, 60); }
      }
    } catch (e) {
      show(`<b>Error</b><br>${esc(e.message)}`);
    } finally {
      busyKey = null;
    }
  }

  // react the instant the page changes (no polling delay), plus a slow backup timer
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

  // ---------------- hotkeys (Option on Mac) ----------------
  function dumpStructure() {
    const clone = document.body.cloneNode(true);
    clone.querySelectorAll('script,style,svg,img,noscript,iframe,video,canvas').forEach(n => n.remove());
    const keep = /^(id|class|role|type|for|name|disabled|aria-.*|data-testid)$/;
    clone.querySelectorAll('*').forEach(el => {
      [...el.attributes].forEach(a => { if (!keep.test(a.name)) el.removeAttribute(a.name); });
    });
    const opts = findOptions();
    const header = `<!-- detected options: ${opts ? opts.map(textOf).join(' | ') : 'NONE'} -->\n` +
                   `<!-- detected question: ${opts ? findQuestion(opts) : 'n/a'} -->\n`;
    const html = header + clone.outerHTML.slice(0, 30000);
    GM_setClipboard(html);
    console.log(html);
    show('<b>Page structure copied</b><br>Paste it into the chat with Claude');
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
})();
