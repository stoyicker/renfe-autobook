// ============================================================
// BACKGROUND SERVICE WORKER
// ============================================================
// Responsibilities:
//   1. Listen for omnibox input ("renfe go 15apr return 20apr")
//   2. Parse outbound and return dates from the input
//   3. Store parsed data + initial state in chrome.storage.session
//   4. Navigate the active tab to renfe.com (triggers content script)
// ============================================================

// --- Allow content scripts to access session storage -------------------------
// Must run both at top level AND on install to guarantee it's set before
// any content script tries to access session storage.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
});

// --- Date parsing -----------------------------------------------------------

/**
 * Parse a loose date string into { day, month, year }.
 * Supported formats:
 *   "15apr", "15/04", "april 15", "15-04", "15 apr", "15 april", "apr15"
 * Defaults to current year. Returns null if unparseable.
 */
function parseLooseDate(raw) {
  if (!raw) return null;
  raw = raw.trim().toLowerCase();

  const MONTHS = {
    jan: 1, ene: 1, january: 1, enero: 1,
    feb: 2, february: 2, febrero: 2,
    mar: 3, march: 3, marzo: 3,
    apr: 4, abr: 4, april: 4, abril: 4,
    may: 5, mayo: 5,
    jun: 6, june: 6, junio: 6,
    jul: 7, july: 7, julio: 7,
    aug: 8, ago: 8, august: 8, agosto: 8,
    sep: 9, sept: 9, september: 9, septiembre: 9,
    oct: 10, october: 10, octubre: 10,
    nov: 11, november: 11, noviembre: 11,
    dec: 12, dic: 12, december: 12, diciembre: 12
  };

  const year = new Date().getFullYear();
  let day, month;

  // Try "15/04" or "15-04"
  let m = raw.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
  if (m) {
    day = parseInt(m[1], 10);
    month = parseInt(m[2], 10);
    return { day, month, year };
  }

  // Try "15apr" or "15 apr" or "15april"
  m = raw.match(/^(\d{1,2})\s*([a-záéíóúñ]+)$/);
  if (m) {
    day = parseInt(m[1], 10);
    month = MONTHS[m[2]] || MONTHS[m[2].substring(0, 3)];
    if (month) return { day, month, year };
  }

  // Try "apr15" or "apr 15" or "april 15"
  m = raw.match(/^([a-záéíóúñ]+)\s*(\d{1,2})$/);
  if (m) {
    day = parseInt(m[2], 10);
    month = MONTHS[m[1]] || MONTHS[m[1].substring(0, 3)];
    if (month) return { day, month, year };
  }

  return null;
}

// --- Traveller parsing -------------------------------------------------------

/**
 * Parse who is travelling from a natural language string.
 * The family has 3 members: mom, dad, and "me" (the user).
 *
 * Examples:
 *   "mom and me"        → ['mom', 'me']
 *   "my parents and me" → ['mom', 'dad', 'me']
 *   "dad and me"        → ['dad', 'me']
 *   "mom and dad"       → ['mom', 'dad']
 *   "all 3"             → ['mom', 'dad', 'me']
 *   "me"                → ['me']
 *   "mom"               → ['mom']
 *   (empty / missing)   → null  (error — travellers are required)
 */
function parseTravellers(text) {
  if (!text || !text.trim()) return null;
  text = text.trim().toLowerCase();

  // "all 3", "all three", "todos", "los 3"
  if (/\b(all\s*(3|three)|todos|los\s*3)\b/.test(text)) {
    return ['mom', 'dad', 'me'];
  }

  // "my parents and me", "mis padres y yo"
  if (/\b(my parents|mis padres|parents)\b/.test(text)) {
    const travellers = ['mom', 'dad'];
    if (/\b(and me|y yo|and i)\b/.test(text)) travellers.push('me');
    return travellers;
  }

  const travellers = [];

  // Detect mom: "mom", "mum", "mama", "mamá", "madre", "mother"
  if (/\b(mom|mum|mama|mamá|madre|mother)\b/.test(text)) {
    travellers.push('mom');
  }

  // Detect dad: "dad", "papa", "papá", "padre", "father"
  if (/\b(dad|papa|papá|padre|father)\b/.test(text)) {
    travellers.push('dad');
  }

  // Detect me: "me", "yo", "i", "myself"
  if (/\b(me|yo|myself)\b/.test(text) || /\bi\b/.test(text)) {
    travellers.push('me');
  }

  return travellers.length > 0 ? travellers : null;
}

// --- Full omnibox parsing ----------------------------------------------------

/**
 * Parse the full omnibox text.
 * Format: "go <date> return <date> <travellers>"
 * Also: "ida <date> vuelta <date> <travellers>"
 *
 * Examples:
 *   "go 15apr return 20apr mom and me"
 *   "go 15/04 return 20/04 all 3"
 *   "ida 15abr vuelta 20abr mis padres y yo"
 *
 * Returns { ok, outboundDate, returnDate, travellers, passengerCount }
 * or { ok: false, error: "reason" }.
 */
function parseOmniboxInput(text) {
  text = text.trim().toLowerCase();

  // Match: go <date> return <date> [traveller text]
  const pattern = /(?:go|ida)\s+(.+?)\s+(?:return|vuelta)\s+(\S+)(?:\s+(.+))?/;
  const m = text.match(pattern);
  if (!m) {
    return { ok: false, error: 'Usage: go 15apr return 20apr mom and me' };
  }

  const outboundDate = parseLooseDate(m[1]);
  const returnDate = parseLooseDate(m[2]);

  if (!outboundDate) {
    return { ok: false, error: `No entendí la fecha de ida: "${m[1]}"\n\nFormatos válidos: 15apr, 15/04, april 15` };
  }
  if (!returnDate) {
    return { ok: false, error: `No entendí la fecha de vuelta: "${m[2]}"\n\nFormatos válidos: 20apr, 20/04, april 20` };
  }

  // Smart year rollover:
  // 1. If outbound date is in the past, bump it to next year
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const outboundJs = new Date(outboundDate.year, outboundDate.month - 1, outboundDate.day);
  if (outboundJs < today) {
    outboundDate.year++;
  }
  // 2. If return date is before outbound, it must be next year
  const returnJs = new Date(returnDate.year, returnDate.month - 1, returnDate.day);
  const outboundJsFixed = new Date(outboundDate.year, outboundDate.month - 1, outboundDate.day);
  if (returnJs < outboundJsFixed) {
    returnDate.year++;
  }

  const travellerText = m[3] || '';
  const travellers = parseTravellers(travellerText);

  if (!travellers) {
    return { ok: false, error: 'Falta quién viaja.\n\nEjemplos: mom and me, dad and me, my parents and me, all 3, me' };
  }

  return {
    ok: true,
    outboundDate,
    returnDate,
    travellers,
    passengerCount: travellers.length
  };
}

// --- Omnibox listener -------------------------------------------------------

chrome.omnibox.setDefaultSuggestion({
  description: ' '
});

/**
 * Show a modal error dialog on the active tab, then re-focus the omnibox
 * with the original text so the user can fix it.
 */
async function showInputError(errorMsg, originalText) {
  // Find a usable tab — the active tab may be chrome:// during omnibox use
  const tabs = await chrome.tabs.query({ currentWindow: true });
  let tab = tabs.find(t => t.active && t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('about:'))
    || tabs.find(t => t.url && t.url.startsWith('https://'));
  if (!tab) {
    // No injectable tab — open the error page directly
    const encoded = encodeURIComponent(errorMsg);
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab) {
      chrome.tabs.update(activeTab.id, { url: chrome.runtime.getURL(`error.html?msg=${encoded}`) });
    }
    return;
  }

  // Inject a modal dialog into the page
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (msg) => {
      // Remove any previous error overlay
      document.getElementById('renfe-ext-error-overlay')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'renfe-ext-error-overlay';
      overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 999999;
        background: rgba(0,0,0,0.5);
        display: flex; align-items: center; justify-content: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      `;

      const dialog = document.createElement('div');
      dialog.style.cssText = `
        background: white; border-radius: 12px; padding: 24px 28px;
        max-width: 420px; box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      `;

      const title = document.createElement('div');
      title.textContent = 'Renfe Easy Booking';
      title.style.cssText = 'font-size:16px; font-weight:700; color:#6d28d9; margin-bottom:12px; user-select:none;';

      const body = document.createElement('div');
      body.style.cssText = 'font-size:14px; color:#1a1a1a; white-space:pre-wrap; line-height:1.5; margin-bottom:16px;';
      // Make "Usage:" prefix non-selectable if present
      if (msg.startsWith('Usage:')) {
        const prefix = document.createElement('span');
        prefix.textContent = 'Usage: ';
        prefix.style.cssText = 'user-select:none;';
        const rest = document.createTextNode(msg.substring('Usage: '.length));
        body.appendChild(prefix);
        body.appendChild(rest);
      } else {
        body.textContent = msg;
      }

      const btn = document.createElement('button');
      btn.textContent = 'OK';
      btn.style.cssText = `
        display: block; width: 100%; padding: 10px;
        background: #6d28d9; color: white; border: none; border-radius: 8px;
        font-size: 14px; font-weight: 600; cursor: pointer;
      `;
      btn.onclick = () => overlay.remove();

      // Close on Escape or clicking outside
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      document.addEventListener('keydown', function handler(e) {
        if (e.key === 'Escape' || e.key === 'Enter') {
          overlay.remove();
          document.removeEventListener('keydown', handler);
        }
      });

      dialog.append(title, body, btn);
      overlay.appendChild(dialog);
      document.body.appendChild(overlay);
      btn.focus();
    },
    args: [errorMsg]
  });
}

// Fired when the user presses Enter in the omnibox
chrome.omnibox.onInputEntered.addListener(async (text) => {
  const parsed = parseOmniboxInput(text);

  if (!parsed.ok) {
    await showInputError(parsed.error, text);
    return;
  }

  console.log('[Renfe Extension] Parsed:', parsed);

  // Store the booking request and set initial state
  await chrome.storage.session.set({
    renfeState: 'OPEN_RENFE',
    outboundDate: parsed.outboundDate,
    returnDate: parsed.returnDate,
    travellers: parsed.travellers,
    passengerCount: parsed.passengerCount,
    errorCount: 0
  });

  // Navigate to renfe.com or re-trigger the content script if already there
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    const url = tab.url || '';
    if (url.startsWith('https://www.renfe.com/es/es')) {
      // Already on Renfe — tell the content script to re-run
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'RENFE_RUN' });
      } catch (e) {
        // Content script not loaded yet — reload the tab to trigger it
        chrome.tabs.reload(tab.id);
      }
    } else {
      chrome.tabs.update(tab.id, { url: 'https://www.renfe.com/es/es' });
    }
  }
});

// --- Message listener (from content script & popup) -------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'PING') {
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'SHOW_ERROR') {
    showInputError(msg.error, '');
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === 'STATE_UPDATE') {
    console.log(`[Renfe Extension] State → ${msg.state}`);
    sendResponse({ ok: true });
  }

  // --- Recorder: save step recording to disk as a JSON download ---
  if (msg.type === 'RECORDER_SAVE_TO_DISK') {
    const { stepLabel, events } = msg;
    const payload = {
      step: stepLabel,
      recordedAt: new Date().toISOString(),
      url: events[0]?.url || '',
      eventCount: events.length,
      events: events,
    };
    const json = JSON.stringify(payload, null, 2);
    // Service workers can't use Blob/createObjectURL — use a data: URI instead
    const dataUrl = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(json)));
    const safeName = stepLabel.replace(/[^a-z0-9_-]/gi, '_') || 'unnamed_step';

    chrome.downloads.download({
      url: dataUrl,
      filename: `renfe-recordings/${safeName}.json`,
      saveAs: false,
      conflictAction: 'overwrite'
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[Renfe] Download failed:', chrome.runtime.lastError.message);
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        console.log(`[Renfe] Recording saved: renfe-recordings/${safeName}.json (download ${downloadId})`);
        sendResponse({ ok: true, filename: `renfe-recordings/${safeName}.json` });
      }
    });
    return true; // keep sendResponse channel open for async
  }
});
