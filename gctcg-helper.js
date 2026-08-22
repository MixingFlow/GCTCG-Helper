// ==UserScript==
// @name         GCTCG Helper
// @namespace    https://github.com/MixingFlow/GCTCG-Helper
// @version      1.0.1
// @description  Gamescom EPIX Trading Cards Helper
// @author       MixingFlow
// @match        *://*.gamescom.global/*
// @match        *://gamescom.global/*
// @icon         https://www.gamescom.global/static/meta/favicon.ico
// @license      MIT
// @grant        GM_setClipboard
// @run-at       document-idle
// @downloadURL https://update.greasyfork.org/scripts/592533/GCTCG%20Helper.user.js
// @updateURL https://update.greasyfork.org/scripts/592533/GCTCG%20Helper.meta.js
// ==/UserScript==

(function () {
  'use strict';

  const DB_URL = 'https://raw.githubusercontent.com/MixingFlow/GCTCG-Helper/main/cards/2026.json';
  const IMG = 'https://eu-central-1-gamescom.graphassets.com/AMwDHZTUSMaIlRlMFLL7Qz/quality=value:95/resize=w:320,h:494,fit:crop/sharpen=amount:1/auto_image/';
  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];
  const de = () => document.documentElement.lang === 'de' || location.pathname.startsWith('/de');
  const isCardsPage = () => location.pathname.includes('/epix/cards');
  const log = (...a) => console.log('%c[GCTCG]', 'background:#7c3aed;color:#fff;padding:2px 5px;border-radius:3px;font-weight:bold', ...a);

  let DB = [], byHash = new Map(), byName = new Map(), lastSig = '', observer, timer;

  function placeholderSvg(num, lbl) {
    return 'data:image/svg+xml,' + encodeURIComponent([
      '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="494">',
      '<defs><linearGradient id="b" x2="100%" y2="100%">',
      '<stop stop-color="#24123a"/><stop offset="100%" stop-color="#12071f"/>',
      '</linearGradient></defs>',
      '<rect width="320" height="494" rx="8" fill="url(#b)"/>',
      '<rect x="12" y="12" width="296" height="470" rx="6" fill="none" stroke="#6b21a8" stroke-width="2" stroke-dasharray="8,6"/>',
      '<circle cx="160" cy="205" r="34" fill="#3b0764" stroke="#7e22ce" stroke-width="2"/>',
      '<text x="160" y="217" fill="#d8b4fe" font-family="system-ui" font-size="32" font-weight="bold" text-anchor="middle">?</text>',
      `<text x="160" y="270" fill="#faf5ff" font-family="system-ui" font-size="17" font-weight="bold" text-anchor="middle" letter-spacing="1.5">${lbl.toUpperCase()}</text>`,
      `<text x="160" y="300" fill="#c084fc" font-family="system-ui" font-size="15" font-weight="600" text-anchor="middle">${num}</text>`,
      '</svg>'
    ].join(''));
  }

  function prepCard(el, src, alt, clickTarget) {
    el.setAttribute('data-gctcg', '');
    const img = $$('img', el);
    if (img.length) {
      const m = img.find(i => i.classList.contains('image--img')) || img[0];
      ['srcset', 'sizes', 'data-nimg'].forEach(a => m.removeAttribute(a));
      Object.assign(m.style, { filter: '', opacity: '1', visibility: 'visible', color: 'transparent' });
      m.className = 'image--img is--loaded';
      m.src = src;
      m.alt = alt || '';
      img.forEach(i => i !== m && i.remove());
    }
    const vid = $('video', el);
    if (vid) {
      vid.muted = vid.playsInline = vid.loop = vid.autoplay = true;
      setTimeout(() => vid.play().catch(() => {}), 50);
    }
    if (clickTarget) el.onclick = e => { e.preventDefault(); e.stopPropagation(); clickTarget.click(); };
    return el;
  }

  function section(id, title, pillCls, badge, cards = [], extra = '') {
    const s = document.createElement('section');
    s.id = id;
    s.setAttribute('data-gctcg-section', '');
    s.innerHTML = `
      <div class="gctcg-hdr d-flex justify-content-between align-items-center flex-wrap gap-2">
        <h2 class="gctcg-title d-flex align-items-center gap-2">
          ${title} <span class="gctcg-pill ${pillCls}">${badge}</span>
        </h2>
        ${extra}
      </div>`;
    if (cards.length) {
      const g = document.createElement('div');
      g.className = 'row gx-3 gy-4 g-sm-4';
      cards.forEach(c => g.appendChild(c));
      s.appendChild(g);
    }
    return s;
  }

  function render() {
    if (!isCardsPage()) { lastSig = ''; return; }
    if (!DB.length) return;

    const cards = $$('.card-list--list-item:not([data-gctcg-section] *)');
    if (!cards.length) return;

    const container = cards[0].parentElement;
    const native = [...container.children].filter(e => !e.hasAttribute('data-gctcg'));
    if (!native.length) return;

    if (!$('#gctcg-styles')) document.head.insertAdjacentHTML('beforeend', `<style id="gctcg-styles">${CSS}</style>`);

    // Scan owned cards
    const owned = new Map();
    native.forEach((el, i) => {
      if ($('.card-tile--is-locked', el)) return;
      const img = $('img', el);
      if (!img) return;
      const alt = (img.alt || '').trim(), src = img.src || '', hash = src.split('/').pop().split('?')[0];
      const count = ($('.card-list--list-item-count', el) || el).textContent.match(/x\s*(\d+)/i);
      const db = (hash && byHash.get(hash)) || (alt && byName.get(alt.toLowerCase()));
      owned.set(db?.id || hash || alt || `unknown-${i}`, {
        dbCard: db || { num: '??', id: 0, name: alt || 'Unknown', imageId: hash },
        count: count ? +count[1] : 1, el, alt, src, hash
      });
    });

    const sig = [...owned].map(([k, v]) => `${k}:${v.count}`).sort().join();
    if (!owned.size || (sig === lastSig && $('#gctcg-dup'))) return;
    lastSig = sig;

    // Compute dups & missing
    const dups = [], miss = DB.filter(c => !owned.has(c.id));
    let ext = 0;
    owned.forEach(v => { if (v.count > 1) { dups.push(v); ext += v.count - 1; } });
    dups.sort((a, b) => (a.dbCard.id || 0) - (b.dbCard.id || 0));

    // Rebuild sections
    observer?.disconnect();
    $$('[data-gctcg-section]').forEach(e => e.remove());
    const g = de();

    const dupEls = dups.map(d => prepCard(d.el.cloneNode(true), d.hash ? IMG + d.hash : d.src, d.alt, $('[role="button"],button,a,img', d.el) || d.el));
    const missEls = miss.map(c => {
      const el = cards[0].cloneNode(true);
      el.setAttribute('data-gctcg-miss', '');
      $$('.card-tile--is-advertised, [class*="list-item-count"]', el).forEach(n => n.remove());
      const unk = !c.imageId || c.name.startsWith('Card ');
      const lbl = g ? 'Unveröffentlicht' : 'Unreleased';
      el.title = `${c.num}: ${unk ? lbl : c.name}`;
      return prepCard(el, c.imageId ? IMG + c.imageId : placeholderSvg(c.num, lbl), unk ? lbl : c.name);
    });

    const copyBtn = `<button id="gctcg-copy" class="gctcg-copy">${g ? 'Tauschliste kopieren' : 'Copy Trade List'}</button>`;
    container.before(
      section('gctcg-dup', g ? 'Doppelte Karten' : 'Duplicate Cards', 'gctcg-pill-g', `${dups.length} (+${ext})`, dupEls, copyBtn),
      section('gctcg-miss', g ? 'Fehlende Karten' : 'Missing Cards', 'gctcg-pill-r', `${miss.length}/${DB.length}`, missEls),
      section('gctcg-own', g ? 'Alle Karten' : 'All Cards', 'gctcg-pill-p', `${owned.size}`)
    );

    // Copy handler
    $('#gctcg-copy')?.addEventListener('click', () => {
      const want = miss.filter(m => m.imageId && !m.name.startsWith('Card ')).map(m => m.num.split('-')[1]);
      const have = dups.map(d => `${d.dbCard.num} - ${d.dbCard.name}`).join('\n') || (g ? 'Keine' : 'None');
      const t = `__**${g ? 'BIETE' : 'HAVE'}**__\n\n${have}\n\n__**${g ? 'BRAUCHE' : 'WANT'}**__ (2026 ${g ? 'Karten' : 'cards'})\n\n${want.join(', ') || (g ? 'Keine' : 'None')}`;
      if (window.GM_setClipboard) GM_setClipboard(t); else navigator.clipboard?.writeText(t);
      document.body.insertAdjacentHTML('beforeend', `<div class="gctcg-toast">${g ? 'Kopiert!' : 'Copied!'}</div>`);
      setTimeout(() => $('.gctcg-toast')?.remove(), 2500);
    });

    log(`${owned.size} owned, ${dups.length} dups, ${miss.length} missing`);
    observer?.observe(document.body, { childList: true, subtree: true });
  }

  const CSS = `
    [data-gctcg-section] { margin: 2rem 0 }
    .gctcg-hdr { border-bottom: 2px solid rgba(255,255,255,.15); padding-bottom: .75rem; margin-bottom: 1.25rem }
    .gctcg-title { font-size: 1.5rem; font-weight: 700; color: #fff; margin: 0 }
    .gctcg-pill { font-size: .8rem; font-weight: 600; padding: .2rem .65rem; border-radius: 999px; border: 1px solid }
    .gctcg-pill-g { background: rgba(16,185,129,.2); border-color: rgba(16,185,129,.4); color: #34d399 }
    .gctcg-pill-r { background: rgba(239,68,68,.2); border-color: rgba(239,68,68,.4); color: #f87171 }
    .gctcg-pill-p { background: rgba(168,85,247,.2); border-color: rgba(168,85,247,.4); color: #c084fc }
    [data-gctcg-miss] img { filter: grayscale(1) brightness(.85) contrast(1.05) !important; opacity: 1 !important; transition: filter .25s }
    [data-gctcg-miss]:hover img { filter: grayscale(.25) brightness(.98) !important }
    [data-gctcg-miss] video { filter: grayscale(1) brightness(.8) !important; opacity: 1 !important; transition: filter .25s }
    [data-gctcg-miss]:hover video { filter: none !important }
    .gctcg-copy { cursor: pointer; font-size: .85rem; font-weight: 600; padding: .35rem .8rem; border-radius: 6px; background: #7c3aed; border: 1px solid #8b5cf6; color: #fff }
    .gctcg-toast { position: fixed; bottom: 24px; right: 24px; background: #0f172a; border: 1px solid #10b981; color: #fff; padding: 10px 18px; border-radius: 8px; z-index: 999999 }`;

  const trigger = () => { clearTimeout(timer); timer = setTimeout(render, 250); };
  observer = new MutationObserver(m => m.some(x => x.addedNodes.length && !x.target.closest?.('[data-gctcg-section]')) && trigger());
  observer.observe(document.body, { childList: true, subtree: true });

  // Hook Next.js SPA navigation
  ['pushState', 'replaceState'].forEach(method => {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      trigger();
      return result;
    };
  });
  window.addEventListener('popstate', trigger);

  fetch(DB_URL).then(r => r.json()).then(res => {
    DB = res.map((r, i) => {
      const [id, name, hash] = Array.isArray(r) ? r : [r.id, r.name, r.imageId];
      const num = `26-${String(id || i + 1).padStart(2, '0')}`;
      return { id: id || i + 1, name: name || `Card ${num}`, imageId: hash || '', num };
    });
    DB.forEach(c => { if (c.imageId) byHash.set(c.imageId, c); if (c.name) byName.set(c.name.toLowerCase(), c); });
    log(`Loaded ${DB.length} cards`);
    trigger();
  }).catch(e => log('DB load failed', e));
})();
