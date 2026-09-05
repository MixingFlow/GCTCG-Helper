// ==UserScript==
// @name         GCTCG Helper
// @namespace    https://github.com/MixingFlow/GCTCG-Helper
// @version      1.0.3
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

  const DB_URL = 'https://raw.githubusercontent.com/MixingFlow/GCTCG-Helper/main/cards/2026.json';
  const IMAGE_BASE = 'https://eu-central-1-gamescom.graphassets.com/AMwDHZTUSMaIlRlMFLL7Qz/quality=value:95/resize=w:320,h:494,fit:crop/sharpen=amount:1/auto_image/';
  
  const $ = (selector, context = document) => context.querySelector(selector);
  const $$ = (selector, context = document) => [...context.querySelectorAll(selector)];
  const isGerman = () => document.documentElement.lang === 'de' || location.pathname.startsWith('/de');
  const isCardsPage = () => location.pathname.includes('/epix/cards');
  const log = (...args) => console.log('%c[GCTCG]', 'background:#7c3aed;color:#fff;padding:2px 5px;border-radius:3px;font-weight:bold', ...args);

  // Global State
  let database = [];
  let cardsByHash = new Map();
  let cardsByName = new Map();
  let myUserId = '';
  let myAuthToken = '';
  let myOwnedCards = null;
  let lastRenderSignature = '';
  let uiObserver = null;
  let renderTimer = null;
  const tradeAds = new Map();

  // 1. API Interceptor
  // We inject this to capture the auth token and intercept incoming API data
  const interceptorScript = document.createElement('script');
  interceptorScript.textContent = `(function() {
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
      const url = (args[0] instanceof Request ? args[0].url : args[0]) || '';
      const headers = args[0] instanceof Request ? args[0].headers : new Headers((args[1] || {}).headers);
      const auth = headers.get('Authorization') || '';

      // Capture auth token for our auto-generate requests
      if (auth.startsWith('Bearer ') && !window.__gctcg_token) {
        try {
          window.__gctcg_token = auth;
          const payload = JSON.parse(atob(auth.split('.')[1]));
          const uid = payload.UID || payload.sub;
          window.dispatchEvent(new CustomEvent('gctcg-user', { detail: { uid, token: auth } }));
        } catch(e) {}
      }

      const response = await originalFetch.apply(this, args);

      try {
        if (url.includes('/trade/advertisements?cardType=')) {
          const data = await response.clone().json();
          if (data && data.tradeAdvertisements) {
            const cardType = url.match(/cardType=([^&]+)/)[1];
            window.dispatchEvent(new CustomEvent('gctcg-ads', { detail: { cardType, ads: data.tradeAdvertisements } }));
          }
        } else if (url.includes('/get-cards')) {
          const data = await response.clone().json();
          if (data && data.ownedCards) {
            window.dispatchEvent(new CustomEvent('gctcg-inventory', { detail: data.ownedCards }));
          }
        }
      } catch (e) {}

      return response;
    };
  })()`;
  (document.head || document.documentElement).appendChild(interceptorScript);
  interceptorScript.remove();

  // Listen to intercepted data
  window.addEventListener('gctcg-user', e => { myUserId = e.detail.uid; myAuthToken = e.detail.token; });
  window.addEventListener('gctcg-ads', e => tradeAds.set(e.detail.cardType, e.detail.ads));
  window.addEventListener('gctcg-inventory', e => { myOwnedCards = e.detail; triggerRender(); });

  // 2. UI Helpers
  function createPlaceholderSvg(number, label) {
    const encoded = encodeURIComponent(`
      <svg xmlns="http://www.w3.org/2000/svg" width="320" height="494">
        <defs>
          <linearGradient id="bg" x2="100%" y2="100%">
            <stop stop-color="#24123a"/><stop offset="100%" stop-color="#12071f"/>
          </linearGradient>
        </defs>
        <rect width="320" height="494" rx="8" fill="url(#bg)"/>
        <rect x="12" y="12" width="296" height="470" rx="6" fill="none" stroke="#6b21a8" stroke-width="2" stroke-dasharray="8,6"/>
        <circle cx="160" cy="205" r="34" fill="#3b0764" stroke="#7e22ce" stroke-width="2"/>
        <text x="160" y="217" fill="#d8b4fe" font-family="system-ui" font-size="32" font-weight="bold" text-anchor="middle">?</text>
        <text x="160" y="270" fill="#faf5ff" font-family="system-ui" font-size="17" font-weight="bold" text-anchor="middle" letter-spacing="1.5">${label.toUpperCase()}</text>
        <text x="160" y="300" fill="#c084fc" font-family="system-ui" font-size="15" font-weight="600" text-anchor="middle">${number}</text>
      </svg>
    `);
    return `data:image/svg+xml,${encoded}`;
  }

  function cloneAndPrepareCard(templateNode, imgSrc, altText, clickTargetNode) {
    const card = templateNode.cloneNode(true);
    card.removeAttribute('data-gctcg-miss');
    card.setAttribute('data-gctcg', '');

    // Replace the image cleanly
    const imageContainer = $('.image', card);
    if (imageContainer) {
      imageContainer.innerHTML = `<img alt="${altText || ''}" loading="lazy" class="image--img is--loaded" style="opacity: 1; visibility: visible;" src="${imgSrc}">`;
    }

    // Force video to play if it's a holo card
    const video = $('video', card);
    if (video) {
      video.play().catch(() => {});
    }

    // Forward clicks to the real card if provided
    if (clickTargetNode) {
      card.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        clickTargetNode.click();
      };
    }

    return card;
  }

  function createSection(id, title, colorClass, badgeText, cardElements = [], extraHtml = '') {
    const section = document.createElement('section');
    section.id = id;
    section.setAttribute('data-gctcg-section', '');
    
    section.innerHTML = `
      <div class="gctcg-hdr d-flex justify-content-between align-items-center flex-wrap gap-2">
        <h2 class="gctcg-title d-flex align-items-center gap-2">
          ${title} <span class="gctcg-pill ${colorClass}">${badgeText}</span>
        </h2>
        <div class="d-flex gap-2">${extraHtml}</div>
      </div>
    `;

    if (cardElements.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'row gx-3 gy-4 g-sm-4';
      cardElements.forEach(card => grid.appendChild(card));
      section.appendChild(grid);
    }

    return section;
  }

  // Trade list copy/generate handler (standalone, called from render's button listeners)
  async function handleCopy(shouldAutoGenerate, duplicates, missing, isDe) {
    const button = shouldAutoGenerate ? $('#gctcg-auto') : $('#gctcg-copy');
    const originalText = button.textContent;

    if (shouldAutoGenerate) {
      button.textContent = isDe ? 'Generiere Links...' : 'Generating Links...';
    }

    const wantedNumbers = missing
      .filter(m => m.imageId && !m.name.startsWith('Card '))
      .map(m => m.num.split('-')[1]);

    const haveLines = [];

    for (const dup of duplicates) {
      let textLine = `${dup.dbCard.num} - ${dup.dbCard.name}`;
      const cardType = dup.hygraphId;

      if (cardType && myUserId && myAuthToken) {
        const allAdsForCard = tradeAds.get(cardType) || [];
        let activeAd = allAdsForCard.find(ad => ad.userId === myUserId && ad.closedAt === null);

        if (!activeAd && shouldAutoGenerate) {
          try {
            const response = await fetch('https://wfppjum4x2.execute-api.eu-central-1.amazonaws.com/production/trade/advertisements', {
              method: 'POST',
              headers: { 'Authorization': myAuthToken, 'Content-Type': 'application/json' },
              body: JSON.stringify({ cards: [cardType] })
            });
            const data = await response.json();

            if (data && data.tradeAdvertisementId) {
              activeAd = { id: data.tradeAdvertisementId, userId: myUserId, closedAt: null };
              allAdsForCard.push(activeAd);
              tradeAds.set(cardType, allAdsForCard);
            }
          } catch (error) {
            log('Failed to auto-generate trade link for', dup.dbCard.name, error);
          }
        }

        if (activeAd) {
          textLine = `[${textLine}](https://www.gamescom.global/de/epix/cards?advertisementId=${activeAd.id})`;
        }
      }
      haveLines.push(textLine);
    }

    button.textContent = originalText;

    const haveBlock = haveLines.join('\n') || (isDe ? 'Keine' : 'None');
    const wantBlock = wantedNumbers.join(', ') || (isDe ? 'Keine' : 'None');
    const finalClipboardText = `__**${isDe ? 'BIETE' : 'HAVE'}**__\n\n${haveBlock}\n\n__**${isDe ? 'BRAUCHE' : 'WANT'}**__ (2026 ${isDe ? 'Karten' : 'cards'})\n\n${wantBlock}`;

    if (window.GM_setClipboard) {
      GM_setClipboard(finalClipboardText);
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(finalClipboardText);
    }

    document.body.insertAdjacentHTML('beforeend', `<div class="gctcg-toast">${isDe ? 'Kopiert!' : 'Copied!'}</div>`);
    setTimeout(() => $('.gctcg-toast')?.remove(), 2500);
  }

  // 3. Core Logic
  function render() {
    if (!isCardsPage()) {
      lastRenderSignature = '';
      return;
    }
    
    if (database.length === 0 || myOwnedCards === null) return;

    const nativeCards = $$('.card-list--list-item:not([data-gctcg-section] *)');
    if (nativeCards.length === 0) return;
    
    const cardContainer = nativeCards[0].parentElement;

    if (!$('#gctcg-styles')) {
      document.head.insertAdjacentHTML('beforeend', `<style id="gctcg-styles">${STYLES}</style>`);
    }

    // Find the real elements in the DOM so we can forward clicks to them
    const nativeElementsByHash = new Map();
    [...cardContainer.children].forEach(element => {
      if (element.hasAttribute('data-gctcg')) return;
      const img = $('img', element);
      if (img) {
        const hash = img.src.split('/').pop().split('?')[0];
        nativeElementsByHash.set(hash, element);
      }
    });

    // Tally up our inventory, strictly filtering to 2026 cards to prevent cross-season bugs
    const inventory = new Map();
    const cards2026 = myOwnedCards.filter(card => card.season === 'season_2026');
    
    for (const apiCard of cards2026) {
      const hash = apiCard.mainAsset?.handle;
      if (!hash) continue;

      // Find the card in our DB using the image hash.
      // If Gamescom changed the image hash, fallback to matching by exact name.
      const nameLower = (apiCard.name || '').toLowerCase();
      let dbMatch = cardsByHash.get(hash) || cardsByName.get(nameLower);
      
      if (!dbMatch) {
        dbMatch = { id: 0, num: '??', name: apiCard.name || 'Unknown', imageId: hash };
      }

      const key = dbMatch.id || hash;
      if (!inventory.has(key)) {
        inventory.set(key, { 
          dbCard: dbMatch, 
          count: 0, 
          hash: hash, 
          hygraphId: apiCard.hygraphModelId 
        });
      }
      inventory.get(key).count++;
    }

    // Abort render if inventory hasn't changed to save CPU
    const signature = [...inventory].map(([key, item]) => `${key}:${item.count}`).sort().join();
    if (inventory.size === 0 || (signature === lastRenderSignature && $('#gctcg-dup'))) return;
    lastRenderSignature = signature;

    // Categorize cards
    const duplicates = [];
    let extraDuplicatesCount = 0;
    
    for (const item of inventory.values()) {
      if (item.count > 1) {
        duplicates.push(item);
        extraDuplicatesCount += (item.count - 1);
      }
    }
    duplicates.sort((a, b) => database.indexOf(a.dbCard) - database.indexOf(b.dbCard));

    const missing = database.filter(dbCard => !inventory.has(dbCard.id));

    // Clear old sections and pause DOM observer temporarily
    if (uiObserver) uiObserver.disconnect();
    $$('[data-gctcg-section]').forEach(element => element.remove());

    const isDe = isGerman();
    const templateNode = nativeCards[0].cloneNode(true);
    $$('.card-tile--is-advertised, [class*="list-item-count"]', templateNode).forEach(n => n.remove());

    // Build Duplicate Card Elements
    const duplicateElements = duplicates.map(dup => {
      const targetElement = nativeElementsByHash.get(dup.hash);
      const clickTarget = targetElement ? ($('[role="button"],button,a,img', targetElement) || targetElement) : null;
      
      const card = cloneAndPrepareCard(templateNode, dup.hash ? (IMAGE_BASE + dup.hash) : '', dup.dbCard.name, clickTarget);
      
      const countLabel = document.createElement('div');
      countLabel.className = 'card-list--list-item-count d-flex mt-1 justify-content-end';
      countLabel.textContent = `x${dup.count}`;
      card.appendChild(countLabel);
      
      return card;
    });

    // Build Missing Card Elements
    const missingElements = missing.map(missCard => {
      const isUnrevealed = !missCard.imageId || missCard.name.startsWith('Card ');
      const unrevealedLabel = isDe ? 'Unveröffentlicht' : 'Unreleased';
      const label = isUnrevealed ? unrevealedLabel : missCard.name;
      const imgSrc = missCard.imageId ? (IMAGE_BASE + missCard.imageId) : createPlaceholderSvg(missCard.num, unrevealedLabel);

      const card = cloneAndPrepareCard(templateNode, imgSrc, label, null);
      card.setAttribute('data-gctcg-miss', '');
      card.title = `${missCard.num}: ${label}`;
      return card;
    });

    // Append to DOM
    const copyButton = `<button id="gctcg-copy" class="gctcg-btn">${isDe ? 'Tauschliste kopieren' : 'Copy Trade List'}</button>`;
    const autoButton = `<button id="gctcg-auto" class="gctcg-btn gctcg-btn-auto">${isDe ? 'Links generieren & kopieren' : 'Auto-Generate Links & Copy'}</button>`;
    
    cardContainer.before(
      createSection('gctcg-dup', isDe ? 'Doppelte Karten' : 'Duplicate Cards', 'gctcg-pill-green', `${duplicates.length} (+${extraDuplicatesCount})`, duplicateElements, copyButton + autoButton),
      createSection('gctcg-miss', isDe ? 'Fehlende Karten' : 'Missing Cards', 'gctcg-pill-red', `${missing.length}/${database.length}`, missingElements),
      createSection('gctcg-own', isDe ? 'Alle Karten' : 'All Cards', 'gctcg-pill-purple', `${inventory.size}`)
    );

    $('#gctcg-copy')?.addEventListener('click', () => handleCopy(false, duplicates, missing, isDe));
    $('#gctcg-auto')?.addEventListener('click', () => handleCopy(true, duplicates, missing, isDe));

    log(`Render complete: ${inventory.size} owned, ${duplicates.length} duplicates, ${missing.length} missing`);
    
    // Resume observing
    if (uiObserver) uiObserver.observe(document.body, { childList: true, subtree: true });
  }

  const STYLES = `
    [data-gctcg-section] { margin: 2.5rem 0; }
    .gctcg-hdr { border-bottom: 2px solid rgba(255, 255, 255, 0.15); padding-bottom: 0.75rem; margin-bottom: 1.25rem; }
    .gctcg-title { font-size: 1.5rem; font-weight: 700; color: #fff; margin: 0; }
    .gctcg-pill { font-size: 0.8rem; font-weight: 600; padding: 0.2rem 0.65rem; border-radius: 999px; border: 1px solid; }
    .gctcg-pill-green { background: rgba(16, 185, 129, 0.2); border-color: rgba(16, 185, 129, 0.4); color: #34d399; }
    .gctcg-pill-red { background: rgba(239, 68, 68, 0.2); border-color: rgba(239, 68, 68, 0.4); color: #f87171; }
    .gctcg-pill-purple { background: rgba(168, 85, 247, 0.2); border-color: rgba(168, 85, 247, 0.4); color: #c084fc; }
    .gctcg-btn { cursor: pointer; font-size: 0.85rem; font-weight: 600; padding: 0.4rem 0.85rem; border-radius: 6px; background: #7c3aed; border: 1px solid #8b5cf6; color: #fff; transition: opacity 0.2s; }
    .gctcg-btn:hover { opacity: 0.9; }
    .gctcg-btn-auto { background: #10b981; border-color: #059669; }
    .gctcg-toast { position: fixed; bottom: 24px; right: 24px; background: #0f172a; border: 1px solid #10b981; color: #fff; padding: 10px 18px; border-radius: 8px; z-index: 999999; }
    [data-gctcg-miss] img { filter: grayscale(1) brightness(0.85) contrast(1.05) !important; opacity: 1 !important; transition: filter 0.25s; }
    [data-gctcg-miss]:hover img { filter: grayscale(0.25) brightness(0.98) !important; }
    [data-gctcg-miss] video { filter: grayscale(1) brightness(0.8) !important; opacity: 1 !important; transition: filter 0.25s; }
    [data-gctcg-miss]:hover video { filter: none !important; }
  `;

  // 4. Initialization
  const triggerRender = () => {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 250);
  };

  const setupObserver = () => {
    if (uiObserver) return;
    uiObserver = new MutationObserver(mutations => {
      const isRelevantChange = mutations.some(m => m.addedNodes.length > 0 && !m.target.closest?.('[data-gctcg-section]'));
      if (isRelevantChange) triggerRender();
    });
    uiObserver.observe(document.body, { childList: true, subtree: true });
    triggerRender();
  };

  // Hook SPA navigation so we re-render when changing pages
  ['pushState', 'replaceState'].forEach(methodName => {
    const originalMethod = history[methodName];
    history[methodName] = function (...args) {
      const result = originalMethod.apply(this, args);
      triggerRender();
      return result;
    };
  });
  window.addEventListener('popstate', triggerRender);

  // Load the database
  fetch(DB_URL)
    .then(r => r.json())
    .then(data => {
      database = data.map((entry, index) => {
        const [id, name, hash] = Array.isArray(entry) ? entry : [entry.id, entry.name, entry.imageId];
        const computedId = id !== undefined ? id : (index + 1);
        const num = String(computedId).startsWith('26-')
          ? computedId
          : (String(computedId) === '1'
              ? '26-1'
              : `26-${String(computedId).padStart(2, '0')}`);
        return { id: computedId, name: name || `Card ${num}`, imageId: hash || '', num };
      });
      
      database.forEach(card => {
        if (card.imageId) cardsByHash.set(card.imageId, card);
        if (card.name) cardsByName.set(card.name.toLowerCase(), card);
      });
      
      log(`Loaded ${database.length} cards`);
      
      if (document.body) setupObserver();
      else window.addEventListener('DOMContentLoaded', setupObserver);
    })
    .catch(error => log('Failed to load database', error));

})();
