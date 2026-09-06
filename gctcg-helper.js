// ==UserScript==
// @name         GCTCG Helper
// @namespace    https://github.com/MixingFlow/GCTCG-Helper
// @version      1.2.0
// @description  Gamescom EPIX Trading Cards Helper
// @author       MixingFlow
// @match        *://*.gamescom.global/*
// @match        *://gamescom.global/*
// @icon         https://www.gamescom.global/static/meta/favicon.ico
// @grant        GM_setClipboard
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const YEARS = [
    { year: 2026, season: 'season_2026', prefix: '26', url: 'https://raw.githubusercontent.com/MixingFlow/GCTCG-Helper/main/cards/2026.json' },
    { year: 2025, season: 'season_2025', prefix: '25', url: 'https://raw.githubusercontent.com/MixingFlow/GCTCG-Helper/main/cards/2025.json' },
    { year: 2024, season: 'season_2024', prefix: '24', url: 'https://raw.githubusercontent.com/MixingFlow/GCTCG-Helper/main/cards/2024.json' }
  ];
  const IMAGE_BASE = 'https://eu-central-1-gamescom.graphassets.com/AMwDHZTUSMaIlRlMFLL7Qz/quality=value:95/resize=w:320,h:494,fit:crop/sharpen=amount:1/auto_image/';

  const $ = (s, c = document) => c.querySelector(s);
  const $$ = (s, c = document) => [...c.querySelectorAll(s)];
  const isGerman = () => document.documentElement.lang === 'de' || location.pathname.startsWith('/de');
  const isCardsPage = () => location.pathname.includes('/epix/cards');
  const log = (...args) => console.log('%c[GCTCG]', 'background:#7c3aed;color:#fff;padding:2px 5px;border-radius:3px;font-weight:bold', ...args);

  function getEnabledYears() {
    try {
      const stored = JSON.parse(localStorage.getItem('gctcg-enabled-years'));
      if (Array.isArray(stored) && stored.length > 0) return new Set(stored.map(Number));
    } catch (e) { }
    return new Set([2026]);
  }

  // Global State
  const yearData = new Map();
  const currentYearResults = new Map();
  const nativeElementsByHash = new Map();
  const tradeAds = new Map();
  let myUserId = '', myAuthToken = '', myOwnedCards = null;
  let uiObserver = null, renderTimer = null;

  // 1. API Interceptor
  const interceptor = document.createElement('script');
  interceptor.textContent = `(function() {
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
      let url = (args[0] instanceof Request ? args[0].url : args[0]) || '';
      const auth = (args[0] instanceof Request ? args[0].headers : new Headers((args[1] || {}).headers)).get('Authorization') || '';

      if (auth.startsWith('Bearer ') && !window.__gctcg_token) {
        try {
          window.__gctcg_token = auth;
          const payload = JSON.parse(atob(auth.split('.')[1]));
          window.dispatchEvent(new CustomEvent('gctcg-user', { detail: { uid: payload.UID || payload.sub, token: auth } }));
        } catch(e) {}
      }

      if (url.includes('get-cards') && url.includes('includeCardsFromOldSeasons=false')) {
        const newUrl = url.replace('includeCardsFromOldSeasons=false', 'includeCardsFromOldSeasons=true');
        args[0] = args[0] instanceof Request ? new Request(newUrl, args[0]) : newUrl;
        url = newUrl;
      }

      const res = await originalFetch.apply(this, args);
      try {
        if (url.includes('/trade/advertisements?cardType=')) {
          const data = await res.clone().json();
          if (data?.tradeAdvertisements) window.dispatchEvent(new CustomEvent('gctcg-ads', { detail: { cardType: url.match(/cardType=([^&]+)/)[1], ads: data.tradeAdvertisements } }));
        } else if (url.includes('/get-cards')) {
          const data = await res.clone().json();
          if (data?.ownedCards) window.dispatchEvent(new CustomEvent('gctcg-inventory', { detail: data.ownedCards }));
        }
      } catch (e) {}
      return res;
    };
  })()`;
  (document.head || document.documentElement).appendChild(interceptor);
  interceptor.remove();

  window.addEventListener('gctcg-user', e => { myUserId = e.detail.uid; myAuthToken = e.detail.token; });
  window.addEventListener('gctcg-ads', e => tradeAds.set(e.detail.cardType, e.detail.ads));
  window.addEventListener('gctcg-inventory', e => { myOwnedCards = e.detail; triggerRender(); });

  // 2. HTML Templates
  const getCardHtml = (src, label, isMiss, hash, count, yr) => `
    <div class="col-6 col-lg-4 col-xl-3 card-list--list-item" data-gctcg-year="${yr}" ${hash ? `data-target-hash="${hash}"` : ''}>
      <div class="card-tile h-100 position-relative" ${isMiss ? 'data-gctcg-miss' : 'data-gctcg'}>
        <div class="transform-3d card-tile--image h-100 transform-origin-y-center enable-holo-effect">
          <div class="transform-3d--wrapper" style="--scale: 1.08;">
            <div class="transform-3d--content">
              <div class="card-tile--rarity w-100 h-100 card-tile--rarity-common">
                <div class="image--wrapper aspect-ratio--1-1.542324">
                  <div class="image h-100 w-100">
                    <img alt="${label}" src="${src}" class="image--img is--loaded" draggable="false" loading="lazy">
                  </div>
                </div>
              </div>
              <span class="transform-3d--light"></span><span class="transform-3d--darkness"></span>
            </div>
          </div>
        </div>
      </div>
      ${count ? `<div class="card-list--list-item-count d-flex mt-1 justify-content-end">x${count}</div>` : ''}
    </div>`;

  const getSectionHtml = (id, title, color, html, extraHtml = '') => `
    <section id="${id}" data-gctcg-section>
      <div class="gctcg-hdr d-flex justify-content-between align-items-center flex-wrap gap-2">
        <h2 class="gctcg-title d-flex align-items-center gap-2">${title} <span class="gctcg-pill ${color}"></span></h2>
        <div class="d-flex gap-2">${extraHtml}</div>
      </div>
      ${html ? `<div class="row gx-3 gy-4 g-sm-4">${html}</div>` : ''}
    </section>`;

  const createSvg = (num, label) => `data:image/svg+xml,${encodeURIComponent(`
    <svg xmlns="http://www.w3.org/2000/svg" width="320" height="494">
      <linearGradient id="bg" x2="100%" y2="100%"><stop stop-color="#24123a"/><stop offset="100%" stop-color="#12071f"/></linearGradient>
      <rect width="320" height="494" rx="8" fill="url(#bg)"/>
      <rect x="12" y="12" width="296" height="470" rx="6" fill="none" stroke="#6b21a8" stroke-width="2" stroke-dasharray="8,6"/>
      <circle cx="160" cy="205" r="34" fill="#3b0764" stroke="#7e22ce" stroke-width="2"/>
      <text x="160" y="217" fill="#d8b4fe" font-family="system-ui" font-size="32" font-weight="bold" text-anchor="middle">?</text>
      <text x="160" y="270" fill="#faf5ff" font-family="system-ui" font-size="17" font-weight="bold" text-anchor="middle" letter-spacing="1.5">${label.toUpperCase()}</text>
      <text x="160" y="300" fill="#c084fc" font-family="system-ui" font-size="15" font-weight="600" text-anchor="middle">${num}</text>
    </svg>`)}`;

  // 3. UI Helpers
  function applyYearVisibility(enabled = getEnabledYears()) {
    const active = YEARS.filter(y => enabled.has(y.year));
    $$('.gctcg-toggle').forEach(btn => btn.classList.toggle('active', enabled.has(Number(btn.dataset.year))));

    $$('[data-gctcg-year]').forEach(el => {
      const yr = Number(el.dataset.gctcgYear);
      if (el.classList.contains('gctcg-year-sep')) {
        const section = el.closest('[data-gctcg-section]');
        const field = section.id === 'gctcg-dup' ? 'duplicates' : 'missing';
        el.style.display = (active.filter(y => currentYearResults.get(y.year)?.[field]?.length > 0).length > 1 && enabled.has(yr)) ? '' : 'none';
      } else {
        el.style.display = enabled.has(yr) ? '' : 'none';
      }
    });

    let dups = 0, extra = 0, miss = 0, total = 0, own = 0;
    active.forEach(y => {
      const r = currentYearResults.get(y.year);
      if (r) { dups += r.duplicates.length; extra += r.extraCount; miss += r.missing.length; total += r.db.length; own += r.inventory.size; }
    });

    if ($('#gctcg-dup .gctcg-pill')) $('#gctcg-dup .gctcg-pill').textContent = `${dups} (+${extra})`;
    if ($('#gctcg-miss .gctcg-pill')) $('#gctcg-miss .gctcg-pill').textContent = `${miss}/${total}`;
    if ($('#gctcg-own .gctcg-pill')) $('#gctcg-own .gctcg-pill').textContent = own;
  }

  async function handleCopy(autoGen) {
    const isDe = isGerman(), btn = autoGen ? $('#gctcg-auto') : $('#gctcg-copy'), origText = btn.textContent;
    if (autoGen) btn.textContent = isDe ? 'Generiere Links...' : 'Generating Links...';
    const enabled = getEnabledYears(), haveBlocks = [], wantBlocks = [];

    for (const { year } of YEARS) {
      if (!enabled.has(year) || !currentYearResults.has(year)) continue;
      const { duplicates, missing } = currentYearResults.get(year);

      const haveLines = [];
      for (const dup of duplicates) {
        let text = `${dup.db.num} - ${dup.db.name}`;
        if (dup.id && myUserId && myAuthToken) {
          let ads = tradeAds.get(dup.id) || [];
          let activeAd = ads.find(a => a.userId === myUserId && !a.closedAt);
          if (!activeAd && autoGen) {
            try {
              const res = await fetch('https://wfppjum4x2.execute-api.eu-central-1.amazonaws.com/production/trade/advertisements', {
                method: 'POST', headers: { 'Authorization': myAuthToken, 'Content-Type': 'application/json' }, body: JSON.stringify({ cards: [dup.id] })
              }).then(r => r.json());
              if (res?.tradeAdvertisementId) {
                activeAd = { id: res.tradeAdvertisementId, userId: myUserId, closedAt: null };
                ads.push(activeAd); tradeAds.set(dup.id, ads);
              }
            } catch (e) { }
          }
          if (activeAd) text = `[${text}](https://www.gamescom.global/${isDe ? 'de' : 'en'}/epix/cards?advertisementId=${activeAd.id})`;
        }
        haveLines.push(text);
      }
      if (haveLines.length) haveBlocks.push(`**${year} ${isDe ? 'Karten' : 'cards'}**\n${haveLines.join('\n')}`);

      const wants = missing.filter(m => m.imageId && !m.name.startsWith('Card ') && m.num !== '26-1').map(m => m.num.split('-')[1]);
      if (wants.length) wantBlocks.push(`**${year} ${isDe ? 'Karten' : 'cards'}**\n${wants.join(', ')}`);
    }

    btn.textContent = origText;
    const none = isDe ? 'Keine' : 'None';
    const text = `__**${isDe ? 'BIETE' : 'HAVE'}**__\n\n${haveBlocks.join('\n\n') || none}\n\n__**${isDe ? 'BRAUCHE' : 'WANT'}**__\n\n${wantBlocks.join('\n\n') || none}`;

    (window.GM_setClipboard || navigator.clipboard.writeText)(text);
    document.body.insertAdjacentHTML('beforeend', `<div class="gctcg-toast">${isDe ? 'Kopiert!' : 'Copied!'}</div>`);
    setTimeout(() => $('.gctcg-toast')?.remove(), 2500);
  }

  // Global Event Delegator
  document.addEventListener('click', e => {
    const toggle = e.target.closest('.gctcg-toggle');
    if (toggle) {
      e.preventDefault(); e.stopPropagation();
      const enabled = getEnabledYears(), yr = Number(toggle.dataset.year);
      if (enabled.has(yr) && enabled.size > 1) enabled.delete(yr);
      else if (!enabled.has(yr)) enabled.add(yr);
      try { localStorage.setItem('gctcg-enabled-years', JSON.stringify([...enabled])); } catch (e) { }
      $('#gctcg-dup') ? applyYearVisibility(enabled) : triggerRender();
      return;
    }
    const card = e.target.closest('[data-target-hash]');
    if (card && nativeElementsByHash.has(card.dataset.targetHash)) {
      e.preventDefault(); e.stopPropagation();
      const native = nativeElementsByHash.get(card.dataset.targetHash);
      (native.querySelector('[role="button"],button,a,img') || native).click();
      return;
    }
    if (e.target.closest('#gctcg-copy')) handleCopy(false);
    if (e.target.closest('#gctcg-auto')) handleCopy(true);
  }, true);

  // 4. Core Render
  function render() {
    if (!isCardsPage() || !yearData.size || !myOwnedCards) return;
    const nativeCards = $$('.card-list--list-item:not([data-gctcg-section] *)');
    if (!nativeCards.length) return;

    if (!$('#gctcg-styles')) document.head.insertAdjacentHTML('beforeend', `<style id="gctcg-styles">${STYLES}</style>`);

    nativeElementsByHash.clear();
    [...nativeCards[0].parentElement.children].forEach(el => {
      if (!el.hasAttribute('data-gctcg')) {
        const img = $('img', el);
        if (img) nativeElementsByHash.set(img.src.split('/').pop().split('?')[0], el);
      }
    });

    currentYearResults.clear();
    YEARS.forEach(y => {
      if (!yearData.has(y.year)) return;
      const db = yearData.get(y.year), inventory = new Map();

      myOwnedCards.filter(c => c.season === y.season).forEach(apiCard => {
        const hash = apiCard.mainAsset?.handle;
        if (!hash) return;
        const nameLower = (apiCard.name || '').toLowerCase();
        const dbMatch = db.find(c => c.imageId === hash || c.name.toLowerCase() === nameLower) || { id: 0, num: '??', name: apiCard.name || 'Unknown', imageId: hash, year: y.year };
        const key = dbMatch.id || hash;
        if (!inventory.has(key)) inventory.set(key, { db: dbMatch, count: 0, hash, id: apiCard.hygraphModelId });
        inventory.get(key).count++;
      });

      const duplicates = [...inventory.values()].filter(i => i.count > 1).sort((a, b) => db.indexOf(a.db) - db.indexOf(b.db));
      const missing = db.filter(c => !inventory.has(c.id));
      currentYearResults.set(y.year, { db, inventory, duplicates, missing, extraCount: duplicates.reduce((s, i) => s + i.count - 1, 0) });
    });

    if (uiObserver) uiObserver.disconnect();
    $$('[data-gctcg-section]').forEach(el => el.remove());

    const isDe = isGerman(), enabled = getEnabledYears();
    let dupHtml = '', missHtml = '';

    YEARS.forEach(({ year }) => {
      const yr = currentYearResults.get(year);
      if (!yr) return;
      const sep = `<div class="col-12 gctcg-year-sep" data-gctcg-year="${year}"><span>${year}</span></div>`;
      if (yr.duplicates.length) dupHtml += sep + yr.duplicates.map(d => getCardHtml(IMAGE_BASE + d.hash, d.db.name, false, d.hash, d.count, year)).join('');
      if (yr.missing.length) missHtml += sep + yr.missing.map(m => {
        const unrev = !m.imageId || m.name.startsWith('Card '), label = unrev ? (isDe ? 'Unveröffentlicht' : 'Unreleased') : m.name;
        return getCardHtml(m.imageId ? IMAGE_BASE + m.imageId : createSvg(m.num, label), label, true, '', 0, year);
      }).join('');
    });

    const btns = `<button id="gctcg-copy" class="gctcg-btn">${isDe ? 'Tauschliste kopieren' : 'Copy Trade List'}</button><button id="gctcg-auto" class="gctcg-btn gctcg-btn-auto">${isDe ? 'Tausch-Links generieren und kopieren' : 'Generate and copy trade links'}</button>`;

    nativeCards[0].parentElement.insertAdjacentHTML('beforebegin',
      `<div id="gctcg-toggles" data-gctcg-section class="gctcg-toggles"><span class="gctcg-toggles-label">${isDe ? 'Jahre:' : 'Years:'}</span>${YEARS.map(y => `<button type="button" class="gctcg-toggle ${enabled.has(y.year) ? 'active' : ''}" data-year="${y.year}">${y.year}</button>`).join('')}</div>` +
      getSectionHtml('gctcg-dup', isDe ? 'Doppelte Karten' : 'Duplicate Cards', 'gctcg-pill-green', dupHtml, btns) +
      getSectionHtml('gctcg-miss', isDe ? 'Fehlende Karten' : 'Missing Cards', 'gctcg-pill-red', missHtml) +
      getSectionHtml('gctcg-own', isDe ? 'Alle Karten' : 'All Cards', 'gctcg-pill-purple', '')
    );

    applyYearVisibility(enabled);
    if (uiObserver) uiObserver.observe(document.body, { childList: true, subtree: true });
  }

  const triggerRender = () => { clearTimeout(renderTimer); renderTimer = setTimeout(render, 250); };
  const setupObserver = () => {
    if (uiObserver) return;
    uiObserver = new MutationObserver(m => { if (!$('#gctcg-dup') && m.some(x => x.addedNodes.length && !x.target.closest?.('[data-gctcg-section]'))) triggerRender(); });
    uiObserver.observe(document.body, { childList: true, subtree: true });
    triggerRender();
  };

  ['pushState', 'replaceState'].forEach(m => { const orig = history[m]; history[m] = function (...a) { const r = orig.apply(this, a); triggerRender(); return r; }; });
  window.addEventListener('popstate', triggerRender);

  Promise.all(YEARS.map(yConfig => fetch(yConfig.url).then(r => r.json()).then(data => {
    yearData.set(yConfig.year, data.map((entry, index) => {
      const [id, name, imageId] = Array.isArray(entry) ? entry : [entry.id, entry.name, entry.imageId];
      const computedId = id !== undefined ? id : (index + 1);
      return { id: computedId, name: name || `Card ${computedId}`, imageId: imageId || '', num: String(computedId).startsWith(`${yConfig.prefix}-`) ? computedId : (yConfig.year === 2026 && String(computedId) === '1') ? '26-1' : `${yConfig.prefix}-${String(computedId).padStart(2, '0')}`, year: yConfig.year };
    }));
  }).catch(e => log(`Failed ${yConfig.year}`, e)))).then(() => document.body ? setupObserver() : window.addEventListener('DOMContentLoaded', setupObserver));

  const STYLES = `
    [data-gctcg-section] { margin: 2.5rem 0; }
    .gctcg-toggles { display: flex; align-items: center; gap: 0.5rem; margin: 1.5rem 0; }
    .gctcg-toggles-label { font-size: 0.9rem; font-weight: 600; color: rgba(255,255,255,0.7); margin-right: 0.25rem; }
    .gctcg-toggle { cursor: pointer; font-size: 0.85rem; font-weight: 600; padding: 0.35rem 0.9rem; border-radius: 99px; border: 1px solid rgba(168,85,247,0.4); background: rgba(168,85,247,0.1); color: #d8b4fe; transition: all 0.2s; }
    .gctcg-toggle:hover { background: rgba(168,85,247,0.25); color: #fff; border-color: rgba(168,85,247,0.7); }
    .gctcg-toggle.active { background: #7c3aed; border-color: #a855f7; color: #fff; box-shadow: 0 0 10px rgba(124,58,237,0.4); }
    .gctcg-year-sep { width: 100%; display: flex; align-items: center; margin: 36px 0 0; color: #c084fc; font-weight: 700; font-size: 1rem; letter-spacing: 0.05em; }
    .gctcg-year-sep::before, .gctcg-year-sep::after { content: ''; flex: 1; border-bottom: 1px solid rgba(168,85,247,0.35); }
    .gctcg-year-sep::before { margin-right: 1rem; } .gctcg-year-sep::after { margin-left: 1rem; }
    .gctcg-hdr { border-bottom: 2px solid rgba(255,255,255,0.15); padding-bottom: 0.75rem; margin-bottom: 1.25rem; }
    .gctcg-title { font-size: 1.5rem; font-weight: 700; color: #fff; margin: 0; }
    .gctcg-pill { font-size: 0.8rem; font-weight: 600; padding: 0.2rem 0.65rem; border-radius: 99px; border: 1px solid; }
    .gctcg-pill-green { background: rgba(16,185,129,0.2); border-color: rgba(16,185,129,0.4); color: #34d399; }
    .gctcg-pill-red { background: rgba(239,68,68,0.2); border-color: rgba(239,68,68,0.4); color: #f87171; }
    .gctcg-pill-purple { background: rgba(168,85,247,0.2); border-color: rgba(168,85,247,0.4); color: #c084fc; }
    .gctcg-btn { cursor: pointer; font-size: 0.85rem; font-weight: 600; padding: 0.4rem 0.85rem; border-radius: 6px; background: #7c3aed; border: 1px solid #8b5cf6; color: #fff; transition: opacity 0.2s; }
    .gctcg-btn:hover { opacity: 0.9; } .gctcg-btn-auto { background: #10b981; border-color: #059669; }
    .gctcg-toast { position: fixed; bottom: 24px; right: 24px; background: #0f172a; border: 1px solid #10b981; color: #fff; padding: 10px 18px; border-radius: 8px; z-index: 999999; }
    [data-gctcg-miss] img { filter: grayscale(1) brightness(0.85) contrast(1.05) !important; opacity: 1 !important; transition: filter 0.25s; }
    [data-gctcg-miss]:hover img { filter: grayscale(0.25) brightness(0.98) !important; }
  `;
})();