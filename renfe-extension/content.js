// ============================================================
// CONTENT SCRIPT — State Machine for Renfe Booking
// ============================================================
// Injected into every renfe.com page. On load, it reads the
// current state from chrome.storage.session and executes
// the corresponding step. After completing a step, it advances
// the state so the next page load picks up where it left off.
//
// State flow:
//   OPEN_RENFE → FILL_SEARCH_FORM → SELECT_OUTBOUND_TRAIN
//   → SELECT_RETURN_TRAIN → SELECT_TRAVELLERS → SELECT_PAYMENT
//   → AWAIT_CONFIRMATION
//
// DISMISS_POPUPS runs before every state as a guard.
// On error → ERROR state + notification.
// ============================================================

(() => {
  'use strict';

  const SEL = window.RENFE_SELECTORS;
  const CFG = window.RENFE_CONFIG;

  // --- Helpers ---------------------------------------------------------------

  function $(selector) {
    if (Array.isArray(selector)) {
      for (const s of selector) {
        const el = document.querySelector(s);
        if (el) return el;
      }
      return null;
    }
    return document.querySelector(selector);
  }

  function $$(selector) {
    if (Array.isArray(selector)) {
      for (const s of selector) {
        const els = document.querySelectorAll(s);
        if (els.length) return Array.from(els);
      }
      return [];
    }
    return Array.from(document.querySelectorAll(selector));
  }

  function delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Wait for an element to appear in the DOM (via polling + MutationObserver).
   */
  function waitForElement(selector, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const existing = $(selector);
      if (existing) return resolve(existing);

      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Timeout waiting for: ${selector}`));
      }, timeoutMs);

      const observer = new MutationObserver(() => {
        const el = $(selector);
        if (el) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(el);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });
    });
  }

  /**
   * Wait for a condition function to return a truthy value.
   */
  function waitFor(conditionFn, timeoutMs = 15000, pollMs = 200) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const result = conditionFn();
        if (result) return resolve(result);
        if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
        setTimeout(check, pollMs);
      };
      check();
    });
  }

  function waitForLoading(timeoutMs = 20000) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        const spinner = $(SEL.loadingSpinner);
        if (!spinner || spinner.offsetParent === null) {
          resolve();
        } else if (Date.now() - start > timeoutMs) {
          resolve();
        } else {
          requestAnimationFrame(check);
        }
      };
      check();
    });
  }

  async function setState(state, detail) {
    await chrome.storage.session.set({ renfeState: state });
    chrome.runtime.sendMessage({ type: 'STATE_UPDATE', state, detail });
    console.log(`[Renfe] State → ${state}`, detail || '');
  }

  async function fail(stepName, reason) {
    const detail = `Error en paso "${stepName}": ${reason}`;
    await chrome.storage.session.set({ renfeState: 'ERROR' });
    chrome.runtime.sendMessage({ type: 'SHOW_ERROR', error: detail });
  }

  // --- Popup dismissal -------------------------------------------------------

  function dismissPopups() {
    const cookieBtn = $(SEL.cookieAcceptBtn);
    if (cookieBtn) {
      cookieBtn.click();
      console.log('[Renfe] Dismissed cookie banner');
    }

    for (const selector of SEL.modalCloseButtons) {
      const btns = document.querySelectorAll(selector);
      btns.forEach(btn => {
        if (btn.offsetParent !== null) {
          btn.click();
          console.log('[Renfe] Closed modal:', selector);
        }
      });
    }
  }

  // --- Station selection (Awesomplete) ---------------------------------------

  /**
   * Type text into a station input char by char to trigger Awesomplete,
   * then click the matching dropdown item.
   *
   * @param {string} inputSelector - CSS selector for the input (#origin or #destination)
   * @param {string} dropdownSelector - CSS selector for the dropdown list
   * @param {string} searchText - Characters to type (e.g. 'helli')
   * @param {string} stationName - Exact text to match in the dropdown (e.g. 'HELLÍN')
   */
  async function selectStation(inputSelector, dropdownSelector, searchText, stationName) {
    const input = $(inputSelector);
    if (!input) throw new Error(`Station input not found: ${inputSelector}`);

    // Skip if the element already has the correct station
    // These are <button> elements, so we read textContent, not .value
    const currentVal = (input.textContent || input.value || '').trim().toUpperCase();
    if (currentVal.includes(stationName.toUpperCase())) {
      console.log(`[Renfe] Station already set: ${stationName} — skipping`);
      return;
    }

    // Focus the input
    input.focus();
    input.dispatchEvent(new Event('focus', { bubbles: true }));
    await delay(300);

    // Clear any existing value
    input.value = '';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: '' }));
    await delay(200);

    // Type characters one by one to trigger Awesomplete filtering
    for (let i = 0; i < searchText.length; i++) {
      input.value = searchText.substring(0, i + 1);
      input.dispatchEvent(new InputEvent('input', {
        bubbles: true,
        data: searchText[i],
        inputType: 'insertText'
      }));
      input.dispatchEvent(new KeyboardEvent('keydown', {
        bubbles: true, key: searchText[i], code: `Key${searchText[i].toUpperCase()}`
      }));
      input.dispatchEvent(new KeyboardEvent('keyup', {
        bubbles: true, key: searchText[i], code: `Key${searchText[i].toUpperCase()}`
      }));
      await delay(100);
    }

    // Wait for the dropdown to appear and have items
    console.log(`[Renfe] Typed "${searchText}", waiting for dropdown...`);
    await delay(800);

    // Wait for dropdown items to appear
    await waitFor(() => {
      const dropdown = $(dropdownSelector);
      if (!dropdown) return false;
      const items = dropdown.querySelectorAll(SEL.autocompleteItem);
      return items.length > 0 ? items : false;
    }, 8000);

    // Find the matching item in the dropdown
    const dropdown = $(dropdownSelector);
    if (!dropdown) throw new Error(`Dropdown not found: ${dropdownSelector}`);

    const items = dropdown.querySelectorAll(SEL.autocompleteItem);
    let matched = null;

    for (const item of items) {
      const text = (item.textContent || '').trim().toUpperCase();
      if (text.includes(stationName.toUpperCase())) {
        matched = item;
        break;
      }
    }

    if (!matched) {
      // Fallback: click the first item
      console.log(`[Renfe] No exact match for "${stationName}", clicking first item`);
      matched = items[0];
    }

    if (!matched) throw new Error(`No dropdown items found for "${stationName}"`);

    console.log(`[Renfe] Clicking station: ${matched.textContent.trim()}`);
    matched.click();
    await delay(500);
  }

  // --- Date picker (Lightpick) -----------------------------------------------

  /**
   * Get the month names currently visible in the calendar.
   * Returns an array of { text, monthIndex, year } for each visible month section.
   * The month label text from Renfe looks like "abril2026" (no space).
   */
  function getVisibleMonths() {
    // Try both selector variants (range vs picker)
    const labels = [
      ...document.querySelectorAll(SEL.monthLabelRange),
      ...document.querySelectorAll(SEL.monthLabelPicker)
    ];

    const MONTH_NAMES = {
      enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
      julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12
    };

    const months = [];
    for (const label of labels) {
      const text = (label.textContent || '').trim().toLowerCase();
      // Parse "abril2026" or "abril 2026"
      for (const [name, idx] of Object.entries(MONTH_NAMES)) {
        if (text.includes(name)) {
          const yearMatch = text.match(/(\d{4})/);
          const year = yearMatch ? parseInt(yearMatch[1]) : new Date().getFullYear();
          months.push({ text: label.textContent.trim(), monthIndex: idx, year });
          break;
        }
      }
    }
    return months;
  }

  /**
   * Navigate the calendar forward or backward until the target month is visible.
   */
  async function navigateToMonth(targetMonth, targetYear) {
    let attempts = 0;
    const maxAttempts = 24; // 2 years max

    while (attempts < maxAttempts) {
      const visible = getVisibleMonths();
      if (visible.length === 0) {
        await delay(500);
        attempts++;
        continue;
      }

      // Check if target month is already visible
      const found = visible.some(v => v.monthIndex === targetMonth && v.year === targetYear);
      if (found) {
        console.log(`[Renfe] Month ${targetMonth}/${targetYear} is visible`);
        return;
      }

      // Determine direction: compare target with first visible month
      const first = visible[0];
      const targetVal = targetYear * 12 + targetMonth;
      const currentVal = first.year * 12 + first.monthIndex;

      if (targetVal > currentVal) {
        // Click next
        const nextBtn = $(SEL.nextMonthBtn);
        if (!nextBtn) throw new Error('Next month button not found');
        nextBtn.click();
      } else {
        // Click prev
        const prevBtn = $(SEL.prevMonthBtn);
        if (!prevBtn) throw new Error('Previous month button not found');
        prevBtn.click();
      }

      await delay(400);
      attempts++;
    }

    throw new Error(`Could not navigate to month ${targetMonth}/${targetYear}`);
  }

  /**
   * Click a specific day cell in the calendar using mousedown (Lightpick requirement).
   * The day cell is identified by its data-time attribute (Unix timestamp in ms).
   */
  async function clickDay(day, month, year) {
    // Lightpick stores timestamps as midnight UTC of the day
    const timestamp = new Date(year, month - 1, day).getTime();
    const selector = `${SEL.dayCellAvailable}[data-time="${timestamp}"]`;

    console.log(`[Renfe] Looking for day cell: ${day}/${month}/${year} (timestamp: ${timestamp})`);

    // Wait for the cell to be available
    let cell;
    try {
      cell = await waitFor(() => $(selector), 5000);
    } catch {
      // If exact timestamp doesn't match, try finding by visible text within available cells
      console.log(`[Renfe] data-time selector failed, trying text match...`);
      const allCells = $$(SEL.dayCellAvailable);
      for (const c of allCells) {
        const cellText = (c.textContent || '').trim();
        if (cellText === String(day)) {
          // Verify it's in the right month section
          const section = c.closest('section.lightpick__month');
          if (section) {
            const label = section.querySelector(
              `${SEL.monthLabelRange}, ${SEL.monthLabelPicker}`
            );
            if (label) {
              const labelText = label.textContent.toLowerCase();
              const MONTH_NAMES_ES = [
                '', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
                'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'
              ];
              if (labelText.includes(MONTH_NAMES_ES[month])) {
                cell = c;
                break;
              }
            }
          }
        }
      }
    }

    if (!cell) throw new Error(`Day cell not found: ${day}/${month}/${year}`);

    console.log(`[Renfe] Clicking day ${day}/${month}/${year}`);

    // Lightpick uses mousedown/pointerdown, NOT click
    cell.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    cell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await delay(100);
    cell.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    cell.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    cell.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    await delay(500);
  }

  /**
   * Check if a date input already contains the expected date.
   * Renfe may display dates as "15/04/2026", "15 abr.", "15 abr. 2026", etc.
   * We check if the day number and month (numeric or name) are present.
   */
  function dateInputMatches(inputEl, date) {
    if (!inputEl) return false;
    const val = (inputEl.textContent || inputEl.value || '').trim();
    if (!val) return false;

    // Format seen: "mié., 15/04/26" — extract dd/mm from it
    const m = val.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
    if (m) {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      if (day === date.day && month === date.month) {
        // If year is present, check it too
        if (m[3]) {
          const yr = parseInt(m[3], 10);
          const fullYear = yr < 100 ? 2000 + yr : yr;
          return fullYear === date.year;
        }
        return true;
      }
    }

    return false;
  }

  /**
   * Open the date picker, select trip mode, pick outbound and return dates, confirm.
   */
  async function selectDates(outboundDate, returnDate) {
    // Check if both dates are already set correctly
    const firstInput = $(SEL.dateFirstInput);
    const secondInput = $(SEL.dateSecondInput);
    if (dateInputMatches(firstInput, outboundDate) && dateInputMatches(secondInput, returnDate)) {
      console.log('[Renfe] Dates already set correctly — skipping');
      return;
    }

    // Click the date input to open the picker
    const dateInput = firstInput || $(SEL.dateTripInput);
    if (!dateInput) throw new Error('Date input not found');

    dateInput.click();
    await delay(800);

    // Always explicitly select round-trip mode (don't rely on default — could be cookie-saved)
    const roundTripLabel = $(SEL.tripRoundLabel);
    if (roundTripLabel) {
      roundTripLabel.click();
      console.log('[Renfe] Selected round-trip mode');
      await delay(500);
    }

    // --- Select outbound date ---
    await navigateToMonth(outboundDate.month, outboundDate.year);
    await delay(300);
    await clickDay(outboundDate.day, outboundDate.month, outboundDate.year);
    console.log(`[Renfe] Outbound date selected: ${outboundDate.day}/${outboundDate.month}/${outboundDate.year}`);

    // --- Select return date (must be after outbound) ---
    await navigateToMonth(returnDate.month, returnDate.year);
    await delay(300);
    await clickDay(returnDate.day, returnDate.month, returnDate.year);
    console.log(`[Renfe] Return date selected: ${returnDate.day}/${returnDate.month}/${returnDate.year}`);

    // Click "Aceptar" to confirm dates
    await delay(300);
    const acceptBtn = $(SEL.dateAcceptBtn);
    if (acceptBtn) {
      acceptBtn.click();
      console.log('[Renfe] Date picker confirmed');
      await delay(500);
    } else {
      console.log('[Renfe] No accept button found — calendar may auto-close');
    }
  }

  // --- Passenger count -------------------------------------------------------

  /**
   * Read the current passenger count from the counter display.
   */
  function readPassengerCount() {
    const display = $(SEL.passengerCountDisplay);
    if (!display) return null;
    const num = parseInt((display.textContent || '').trim(), 10);
    return isNaN(num) ? null : num;
  }

  /**
   * Open the passengers picker, read current count, press +/- to reach
   * the target, and confirm.
   */
  async function selectPassengers(passengerCount) {
    const passBtn = $(SEL.passengersButton);
    if (!passBtn) throw new Error('Passengers button not found');

    // Read current count from the button label (e.g. "2 adultos")
    const btnText = (passBtn.textContent || passBtn.getAttribute('value') || '').trim();
    const target = parseInt(passengerCount, 10);
    const match = btnText.match(/(\d+)/);
    if (!match) {
      throw new Error(`No se pudo leer la cantidad de pasajeros actual. Texto del botón: "${btnText}"`);
    }
    const current = parseInt(match[1], 10);

    if (current === target) {
      console.log(`[Renfe] Passenger count already ${target} — skipping`);
      return;
    }

    const diff = target - current;
    console.log(`[Renfe] Passengers: current=${current}, target=${target}, diff=${diff}`);

    passBtn.click();
    await delay(600);

    // Wait for the passengers list to appear
    await waitForElement(SEL.passengersList, 5000);
    await delay(300);

    if (diff > 0) {
      // Press + diff times
      for (let i = 0; i < diff; i++) {
        const plusBtn = $(SEL.passengerPlusBtn) || $(SEL.passengerPlusIcon);
        if (!plusBtn) throw new Error('Passenger + button not found');
        plusBtn.click();
        await delay(400);
      }
    } else if (diff < 0) {
      // Press - |diff| times
      for (let i = 0; i < Math.abs(diff); i++) {
        const minusBtn = $(SEL.passengerMinusBtn) || $(SEL.passengerMinusIcon);
        if (!minusBtn) throw new Error('Passenger - button not found');
        minusBtn.click();
        await delay(400);
      }
    } else {
      console.log('[Renfe] Passenger count already correct');
    }

    // Click "Listo" to confirm
    await delay(300);
    const doneBtn = $(SEL.passengerDoneBtn);
    if (doneBtn) {
      doneBtn.click();
      console.log(`[Renfe] Passengers confirmed: ${passengerCount}`);
      await delay(500);
    } else {
      console.log('[Renfe] No "Listo" button found');
    }
  }

  // --- Session check -----------------------------------------------------------

  /**
   * Check if the user is logged in.
   * Tries multiple methods: shadow DOM login link, links attribute JSON,
   * and visible "Accede" text in the page.
   */
  function isLoggedIn() {
    const header = document.querySelector('rf-header-topbar-search-integration');

    // Method 1: Check shadow DOM for a loginCEX link (means NOT logged in)
    if (header && header.shadowRoot) {
      const loginLink = header.shadowRoot.querySelector('a[href*="loginCEX"]');
      if (loginLink) return false;
    }

    // Method 2: Check the links attribute JSON
    if (header) {
      const linksAttr = header.getAttribute('links');
      if (linksAttr) {
        try {
          const links = JSON.parse(linksAttr);
          if (links.login?.status === 'logout') return false;
        } catch {}
      }
    }

    // Method 3: Check main DOM for loginCEX links
    const loginLinks = document.querySelectorAll('a[href*="loginCEX"]');
    if (loginLinks.length > 0) return false;

    return true;
  }

  // --- Fill search form (main orchestrator) -----------------------------------

  async function fillSearchForm(outboundDate, returnDate, passengerCount) {
    await waitForLoading();
    dismissPopups();

    await delay(1500); // let the SPA settle

    // Check for active session
    if (!isLoggedIn()) {
      chrome.runtime.sendMessage({
        type: 'SHOW_ERROR',
        error: 'No hay sesión activa en Renfe. Inicia sesión primero y vuelve a intentarlo.'
      });
      await setState('DONE');
      return;
    }

    try {
      // 1. Select origin station
      console.log('[Renfe] Step 1: Selecting origin station...');
      await selectStation(
        SEL.originInput,
        SEL.originDropdown,
        CFG.go.origin.searchText,
        CFG.go.origin.stationName
      );

      // 2. Select destination station
      console.log('[Renfe] Step 2: Selecting destination station...');
      await selectStation(
        SEL.destinationInput,
        SEL.destinationDropdown,
        CFG.go.destination.searchText,
        CFG.go.destination.stationName
      );

      // 3. Select dates (opens calendar, picks round-trip, selects both dates)
      console.log('[Renfe] Step 3: Selecting dates...');
      await selectDates(outboundDate, returnDate);

      // 4. Select passenger count
      console.log('[Renfe] Step 4: Selecting passengers...');
      await selectPassengers(passengerCount);

      dismissPopups();

      // 5. Submit the search
      console.log('[Renfe] Step 5: Submitting search...');
      await delay(500);
      const searchBtn = $(SEL.searchBtn);
      if (!searchBtn) throw new Error('Search button not found');

      searchBtn.click();
      console.log('[Renfe] Search submitted!');

      await setState('SELECT_OUTBOUND_TRAIN');

    } catch (err) {
      console.error('[Renfe] fillSearchForm error:', err);
      await fail('FILL_SEARCH_FORM', err.message);
    }
  }

  // --- Placeholder state handlers (not yet implemented from recordings) ------

  async function selectOutboundTrain() {
    console.log('[Renfe] SELECT_OUTBOUND_TRAIN — not yet implemented (need recordings)');
    await fail('SELECT_OUTBOUND_TRAIN', 'Este paso aún no está implementado. Necesitamos grabar la selección de trenes.');
  }

  async function selectReturnTrain() {
    console.log('[Renfe] SELECT_RETURN_TRAIN — not yet implemented');
    await fail('SELECT_RETURN_TRAIN', 'Este paso aún no está implementado.');
  }

  async function selectTravellers() {
    console.log('[Renfe] SELECT_TRAVELLERS — not yet implemented');
    await fail('SELECT_TRAVELLERS', 'Este paso aún no está implementado.');
  }

  async function selectPayment() {
    console.log('[Renfe] SELECT_PAYMENT — not yet implemented');
    await fail('SELECT_PAYMENT', 'Este paso aún no está implementado.');
  }

  async function awaitConfirmation() {
    console.log('[Renfe] AWAIT_CONFIRMATION — not yet implemented');
    await setState('DONE');
  }

  // --- Main state machine ----------------------------------------------------

  async function run() {
    const data = await chrome.storage.session.get([
      'renfeState', 'outboundDate', 'returnDate', 'passengerCount', 'travellers'
    ]);

    const state = data.renfeState;
    if (!state || state === 'DONE' || state === 'ERROR') {
      return;
    }

    console.log(`[Renfe] Running state: ${state}`, data);

    dismissPopups();

    switch (state) {
      case 'OPEN_RENFE':
        await setState('FILL_SEARCH_FORM');
        await delay(2000);
        await fillSearchForm(data.outboundDate, data.returnDate, data.passengerCount || 1);
        break;

      case 'FILL_SEARCH_FORM':
        await fillSearchForm(data.outboundDate, data.returnDate, data.passengerCount || 1);
        break;

      case 'SELECT_OUTBOUND_TRAIN':
        await selectOutboundTrain();
        break;

      case 'SELECT_RETURN_TRAIN':
        await selectReturnTrain();
        break;

      case 'SELECT_TRAVELLERS':
        await selectTravellers();
        break;

      case 'SELECT_PAYMENT':
        await selectPayment();
        break;

      case 'AWAIT_CONFIRMATION':
        await awaitConfirmation();
        break;

      default:
        console.log(`[Renfe] Unknown state: ${state}`);
        break;
    }
  }

  // --- Init ------------------------------------------------------------------

  // Listen for re-run messages from background (when omnibox is used while already on Renfe)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'RENFE_RUN') {
      console.log('[Renfe] Re-run triggered from omnibox');
      // Small delay to let storage.session.set() from background finish writing
      delay(300).then(() => run());
    }
  });

  async function init() {
    try {
      await chrome.runtime.sendMessage({ type: 'PING' });
    } catch (e) {
      await delay(500);
      try { await chrome.runtime.sendMessage({ type: 'PING' }); } catch (e2) {}
    }
    await run();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
