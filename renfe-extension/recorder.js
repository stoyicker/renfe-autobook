// ============================================================
// RECORDER — Captures user interactions on Renfe pages
// ============================================================
// Records clicks, inputs, selects, navigations, and DOM mutations
// so we can later replay the exact booking flow.
//
// Activated/deactivated via messages from the popup.
// Stores captured events in chrome.storage.session.
// ============================================================

(() => {
  'use strict';

  let recording = false;
  let events = [];
  let seq = 0;
  let mutationObserver = null;
  let pendingMutations = [];
  let lastActionTime = null;

  // --- Selector generation ---------------------------------------------------

  /**
   * Build multiple selector strategies for an element so we have
   * fallbacks when Renfe's DOM changes between sessions.
   */
  function getSelectors(el) {
    return {
      id: el.id || null,
      cssSelector: getCssSelector(el),
      nthChildPath: getNthChildPath(el),
      xpath: getXPath(el),
      tag: el.tagName.toLowerCase(),
      classes: Array.from(el.classList),
      attributes: getRelevantAttributes(el),
      text: (el.textContent || '').trim().substring(0, 120),
      innerText: (el.innerText || '').trim().substring(0, 120),
      ariaLabel: el.getAttribute('aria-label') || null,
      placeholder: el.getAttribute('placeholder') || null,
      name: el.getAttribute('name') || null,
      type: el.getAttribute('type') || null,
      role: el.getAttribute('role') || null,
      value: el.value !== undefined ? el.value : null,
      rect: (() => {
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height) };
      })(),
      isVisible: el.offsetParent !== null,
      parentTag: el.parentElement ? el.parentElement.tagName.toLowerCase() : null,
      parentClasses: el.parentElement ? Array.from(el.parentElement.classList) : [],
      parentId: el.parentElement ? (el.parentElement.id || null) : null,
    };
  }

  /** Build a reasonable CSS selector for an element. */
  function getCssSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;

    const parts = [];
    let current = el;
    while (current && current !== document.body && parts.length < 6) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`);
        break;
      }
      if (current.classList.length > 0) {
        // Use up to 3 classes for specificity
        const classes = Array.from(current.classList).slice(0, 3).map(c => `.${CSS.escape(c)}`).join('');
        part += classes;
      }
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }

  /** Build an nth-child path (very precise but brittle). */
  function getNthChildPath(el) {
    const parts = [];
    let current = el;
    while (current && current !== document.body && parts.length < 8) {
      const parent = current.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(`${current.tagName.toLowerCase()}:nth-child(${index})`);
      current = parent;
    }
    return parts.join(' > ');
  }

  /** Build an XPath for the element. */
  function getXPath(el) {
    const parts = [];
    let current = el;
    while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 8) {
      let part = current.tagName.toLowerCase();
      if (current.id) {
        parts.unshift(`//${part}[@id="${current.id}"]`);
        return parts.join('/');
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (sameTag.length > 1) {
          const idx = sameTag.indexOf(current) + 1;
          part += `[${idx}]`;
        }
      }
      parts.unshift(part);
      current = parent;
    }
    return '/' + parts.join('/');
  }

  /** Grab relevant attributes (skip noisy ones). */
  function getRelevantAttributes(el) {
    const skip = new Set(['class', 'id', 'style', 'onclick', 'onmouseover']);
    const attrs = {};
    for (const attr of el.attributes) {
      if (!skip.has(attr.name) && !attr.name.startsWith('__')) {
        attrs[attr.name] = attr.value.substring(0, 200);
      }
    }
    return attrs;
  }

  // --- Mutation tracking -----------------------------------------------------

  function startMutationObserver() {
    if (mutationObserver) mutationObserver.disconnect();
    pendingMutations = [];

    mutationObserver = new MutationObserver((mutations) => {
      if (!recording) return;
      for (const m of mutations) {
        if (m.type === 'childList' && m.addedNodes.length > 0) {
          for (const node of m.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              pendingMutations.push({
                type: 'added',
                tag: node.tagName.toLowerCase(),
                id: node.id || null,
                classes: node.classList ? Array.from(node.classList) : [],
                text: (node.textContent || '').trim().substring(0, 100),
                childCount: node.children ? node.children.length : 0,
              });
            }
          }
        }
        if (m.type === 'childList' && m.removedNodes.length > 0) {
          for (const node of m.removedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE) {
              pendingMutations.push({
                type: 'removed',
                tag: node.tagName.toLowerCase(),
                id: node.id || null,
                classes: node.classList ? Array.from(node.classList) : [],
              });
            }
          }
        }
      }
    });

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  /** Flush collected mutations and attach them to the most recent event. */
  function flushMutations() {
    const result = pendingMutations.slice(0, 30); // cap to avoid huge payloads
    pendingMutations = [];
    return result;
  }

  // --- Event recording -------------------------------------------------------

  function recordEvent(type, detail) {
    const now = Date.now();
    const entry = {
      seq: ++seq,
      type,
      timestamp: now,
      timeSincePrev: lastActionTime ? now - lastActionTime : 0,
      url: window.location.href,
      ...detail,
    };
    lastActionTime = now;

    // Wait a short moment to collect mutations triggered by this action
    setTimeout(() => {
      entry.mutationsAfter = flushMutations();
      events.push(entry);
      save();
      console.log(`[Recorder] #${entry.seq} ${type}`, entry);
    }, 600);
  }

  function onClickCapture(e) {
    if (!recording) return;
    const el = e.target;
    recordEvent('click', {
      element: getSelectors(el),
    });
  }

  function onPointerDownCapture(e) {
    if (!recording) return;
    const el = e.target;
    // Only record pointerdown on elements that might swallow click events
    // (e.g. calendar day cells in Lightpick)
    recordEvent('pointerdown', {
      element: getSelectors(el),
    });
  }

  function onMouseDownCapture(e) {
    if (!recording) return;
    const el = e.target;
    recordEvent('mousedown', {
      element: getSelectors(el),
    });
  }

  function onInputCapture(e) {
    if (!recording) return;
    const el = e.target;
    recordEvent('input', {
      element: getSelectors(el),
      inputValue: el.value || '',
    });
  }

  function onChangeCapture(e) {
    if (!recording) return;
    const el = e.target;
    recordEvent('change', {
      element: getSelectors(el),
      newValue: el.value || '',
    });
  }

  function onFocusCapture(e) {
    if (!recording) return;
    const el = e.target;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
      recordEvent('focus', {
        element: getSelectors(el),
      });
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  function startRecording() {
    recording = true;
    events = [];
    seq = 0;
    lastActionTime = null;
    pendingMutations = [];

    document.addEventListener('click', onClickCapture, true);
    document.addEventListener('pointerdown', onPointerDownCapture, true);
    document.addEventListener('mousedown', onMouseDownCapture, true);
    document.addEventListener('input', onInputCapture, true);
    document.addEventListener('change', onChangeCapture, true);
    document.addEventListener('focus', onFocusCapture, true);
    startMutationObserver();

    // Record initial page state
    recordEvent('page_load', {
      title: document.title,
      readyState: document.readyState,
    });

    console.log('[Recorder] Started');
  }

  function stopRecording() {
    recording = false;
    document.removeEventListener('click', onClickCapture, true);
    document.removeEventListener('pointerdown', onPointerDownCapture, true);
    document.removeEventListener('mousedown', onMouseDownCapture, true);
    document.removeEventListener('input', onInputCapture, true);
    document.removeEventListener('change', onChangeCapture, true);
    document.removeEventListener('focus', onFocusCapture, true);
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    save();
    console.log('[Recorder] Stopped.', events.length, 'events captured');
  }

  function save() {
    chrome.storage.session.set({ recorderEvents: events });
  }

  // --- Message handling (from popup) ----------------------------------------

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'RECORDER_START') {
      startRecording();
      sendResponse({ ok: true });
    } else if (msg.type === 'RECORDER_STOP') {
      stopRecording();
      sendResponse({ ok: true, eventCount: events.length });
    } else if (msg.type === 'RECORDER_GET_EVENTS') {
      sendResponse({ ok: true, events });
    } else if (msg.type === 'RECORDER_CLEAR') {
      events = [];
      seq = 0;
      chrome.storage.session.remove('recorderEvents');
      sendResponse({ ok: true });
    }
  });

  // If recording was active before a page navigation, resume.
  // Wrapped in try/catch in case session storage access isn't ready yet.
  try {
    chrome.storage.session.get(['recorderActive'], (data) => {
      if (chrome.runtime.lastError) return;
      if (data.recorderActive) {
        chrome.storage.session.get(['recorderEvents'], (d) => {
          if (chrome.runtime.lastError) return;
          events = d.recorderEvents || [];
          seq = events.length;
          startRecording();
        });
      }
    });
  } catch (e) {
    console.log('[Recorder] Session storage not available yet, skipping resume');
  }

})();
