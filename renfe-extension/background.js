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

// --- Time preference parsing -------------------------------------------------

const TIME_WORDS = {
  morning: 'morning', mañana: 'morning', manana: 'morning', am: 'morning',
  evening: 'evening', night: 'evening', eve: 'evening', noche: 'evening',
  tarde: 'evening', pm: 'evening'
};
const TIME_REGEX = new RegExp(`\\b(${Object.keys(TIME_WORDS).join('|')})\\b`);

/**
 * Extract a time preference from a string, returning { time, rest }.
 * `time` is 'morning' or 'evening' or null if not found.
 * `rest` is the string with the time word removed.
 */
function extractTime(text) {
  const m = text.match(TIME_REGEX);
  if (!m) return { time: null, rest: text };
  return {
    time: TIME_WORDS[m[1]],
    rest: (text.substring(0, m.index) + text.substring(m.index + m[0].length)).replace(/\s+/g, ' ').trim()
  };
}

// --- Full omnibox parsing ----------------------------------------------------

/**
 * Parse the full omnibox text.
 *
 * Format: [from/to hel/ab] <date> [morning/evening] [return [<date>] [morning/evening]] <travellers>
 *
 * Direction pair (optional, default "from hel"):
 *   "from hel" / "to ab"  → outbound: Hellín → Albacete
 *   "from ab"  / "to hel" → outbound: Albacete → Hellín
 *   Return trip always flips the stations.
 *
 * Time preference (optional):
 *   morning (aliases: mañana, am) / evening (aliases: night, eve, noche, tarde, pm)
 *   Default outbound: morning. Default return: evening.
 *
 * Return date is optional — defaults to same date as outbound.
 *   "15apr return mom and me" → outbound 15apr morning, return 15apr evening
 *
 * Validation: error if same date AND same time preference on a return trip.
 *
 * Examples:
 *   "15apr return 20apr mom and me"                → morning/evening defaults
 *   "15apr evening return 20apr morning all 3"     → explicit times
 *   "15apr return mom and me"                      → same-day round trip
 *   "15apr return evening mom and me"              → same-day, outbound morning (default), return evening
 *   "from ab 15/04 return 20/04 dad and me"
 *   "15apr mom"                                    → one-way, morning default
 *
 * Returns { ok, outboundDate, returnDate, outboundTime, returnTime, direction, travellers, passengerCount }
 * or { ok: false, error }.
 */
function parseOmniboxInput(text) {
  text = text.trim().toLowerCase();

  // 1. Extract optional direction pair from the start
  let direction = 'from_hel'; // default
  const dirPattern = /^(from|to)\s+(hel|ab)\s+/;
  const dirMatch = text.match(dirPattern);
  if (dirMatch) {
    const verb = dirMatch[1];
    const station = dirMatch[2];
    if ((verb === 'from' && station === 'hel') || (verb === 'to' && station === 'ab')) {
      direction = 'from_hel';
    } else {
      direction = 'from_ab';
    }
    text = text.substring(dirMatch[0].length);
  }

  // 2. Split on "return"/"vuelta" keyword
  let outboundPart, returnPart, hasReturn;

  const returnSplit = text.match(/^(.+?)\s+(?:return|vuelta)\b\s*(.*)$/);

  if (returnSplit) {
    hasReturn = true;
    outboundPart = returnSplit[1].trim();
    returnPart = returnSplit[2].trim();
  } else {
    hasReturn = false;
    outboundPart = text;
    returnPart = null;
  }

  // 3. Parse outbound: first token is date, then optional time word, rest is travellers (if no return)
  //    outboundPart = "<date> [time]" (if return exists) or "<date> [time] <travellers>" (if one-way)
  let outboundRaw, outboundTime, travellerText;

  // Extract the first token as the date
  const firstToken = outboundPart.match(/^(\S+)(?:\s+(.*))?$/);
  if (!firstToken) {
    return { ok: false, error: 'Usage: [from/to hel/ab] 15apr [morning/evening] [return [20apr] [morning/evening]] mom and me' };
  }
  outboundRaw = firstToken[1];
  let outboundRemainder = firstToken[2] || '';

  // Extract time from the remainder
  const outboundTimeResult = extractTime(outboundRemainder);
  outboundTime = outboundTimeResult.time || 'morning'; // default outbound: morning
  outboundRemainder = outboundTimeResult.rest;

  // If no return keyword, the remainder is traveller text
  if (!hasReturn) {
    travellerText = outboundRemainder;
  }

  // 4. Parse return part (if present): optional date, optional time, then travellers
  let returnRaw = null, returnTime = 'evening'; // default return: evening

  if (hasReturn) {
    // returnPart may be: "<date> [time] <travellers>" or "[time] <travellers>" or "<travellers>"
    // Try to parse the first token as a date
    let returnRemainder = returnPart;

    const returnFirstToken = returnPart.match(/^(\S+)(?:\s+(.*))?$/);
    if (returnFirstToken) {
      const possibleDate = parseLooseDate(returnFirstToken[1]);
      if (possibleDate) {
        returnRaw = returnFirstToken[1];
        returnRemainder = returnFirstToken[2] || '';
      }
      // If not a date, the entire returnPart is [time] + travellers (date defaults to outbound)
    }

    // Extract time from remainder
    const returnTimeResult = extractTime(returnRemainder);
    if (returnTimeResult.time) {
      returnTime = returnTimeResult.time;
    }
    travellerText = returnTimeResult.rest;
  }

  // 5. Parse dates
  const outboundDate = parseLooseDate(outboundRaw);
  if (!outboundDate) {
    return { ok: false, error: `No entendí la fecha de ida: "${outboundRaw}"\n\nFormatos válidos: 15apr, 15/04, april 15` };
  }

  let returnDate = null;
  if (hasReturn) {
    if (returnRaw) {
      returnDate = parseLooseDate(returnRaw);
      if (!returnDate) {
        return { ok: false, error: `No entendí la fecha de vuelta: "${returnRaw}"\n\nFormatos válidos: 20apr, 20/04, april 20` };
      }
    } else {
      // Default return date = same as outbound
      returnDate = { ...outboundDate };
    }
  }

  // 6. Smart year rollover
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const outboundJs = new Date(outboundDate.year, outboundDate.month - 1, outboundDate.day);
  if (outboundJs < today) {
    outboundDate.year++;
  }
  if (returnDate) {
    const returnJs = new Date(returnDate.year, returnDate.month - 1, returnDate.day);
    const outboundJsFixed = new Date(outboundDate.year, outboundDate.month - 1, outboundDate.day);
    if (returnJs < outboundJsFixed) {
      returnDate.year++;
    }
  }

  // 7. Validate: same date + same time on a return trip is an error
  if (returnDate &&
      outboundDate.day === returnDate.day &&
      outboundDate.month === returnDate.month &&
      outboundDate.year === returnDate.year &&
      outboundTime === returnTime) {
    return { ok: false, error: `Ida y vuelta el mismo día (${outboundDate.day}/${outboundDate.month}) con el mismo horario (${outboundTime}).\n\nUsa morning/evening para diferenciar.` };
  }

  // 8. Parse travellers
  const travellers = parseTravellers(travellerText);
  if (!travellers) {
    return { ok: false, error: 'Falta quién viaja.\n\nEjemplos: mom and me, dad and me, my parents and me, all 3, me' };
  }

  return {
    ok: true,
    outboundDate,
    returnDate,
    outboundTime,
    returnTime: hasReturn ? returnTime : null,
    direction,
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
    outboundTime: parsed.outboundTime,
    returnTime: parsed.returnTime,
    direction: parsed.direction,
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
