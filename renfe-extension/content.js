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
//   → SELECT_TRAVELLERS → SKIP_UPSELL → SELECT_PAYMENT
//   → AWAIT_CONFIRMATION → POST_PURCHASE
//
// DISMISS_POPUPS runs before every state as a guard.
// On error → ERROR state + notification.
// ============================================================

(() => {
  'use strict';

  const SEL = window.RENFE_SELECTORS;
  const CFG = window.RENFE_CONFIG;
  const PROFILES = window.RENFE_TRAVELLER_PROFILES;

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

  /**
   * Wait for the DOM to settle — resolves once no mutations have occurred
   * for `quietMs` milliseconds. Times out after `timeoutMs`.
   */
  function waitForDomSettle(targetNode = document.body, quietMs = 500, timeoutMs = 15000) {
    return new Promise((resolve) => {
      let timer = null;
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          observer.disconnect();
          resolve();
        }, quietMs);
      });
      observer.observe(targetNode, { childList: true, subtree: true, attributes: true });
      // Start the quiet timer immediately in case no mutations happen at all
      timer = setTimeout(() => {
        observer.disconnect();
        resolve();
      }, quietMs);
      // Hard timeout
      setTimeout(() => {
        clearTimeout(timer);
        observer.disconnect();
        resolve();
      }, timeoutMs);
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
          setTimeout(check, 200);
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
    const detail = `Error in step "${stepName}": ${reason}`;
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
   * Navigate the calendar until a target month is visible on either panel.
   * Arrows move 2 months at a time.
   */
  async function navigateToMonthVisible(targetMonth, targetYear) {
    let attempts = 0;
    const maxAttempts = 24;
    const targetVal = targetYear * 12 + targetMonth;

    while (attempts < maxAttempts) {
      const visible = getVisibleMonths();
      if (visible.length === 0) {
        await delay(500);
        attempts++;
        continue;
      }

      // Check if target is visible on either panel
      if (visible.some(v => v.monthIndex === targetMonth && v.year === targetYear)) {
        console.log(`[Renfe] Month ${targetMonth}/${targetYear} is visible`);
        return;
      }

      const leftVal = visible[0].year * 12 + visible[0].monthIndex;

      if (targetVal > leftVal) {
        const nextBtn = $(SEL.nextMonthBtn);
        if (!nextBtn) throw new Error('Next month button not found');
        nextBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        nextBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        nextBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      } else {
        const prevBtn = $(SEL.prevMonthBtn);
        if (!prevBtn) throw new Error('Previous month button not found');
        prevBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        prevBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        prevBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
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
    const isRoundTrip = !!returnDate;

    // Check if dates are already set correctly
    const firstInput = $(SEL.dateFirstInput);
    const secondInput = $(SEL.dateSecondInput);
    if (isRoundTrip) {
      if (dateInputMatches(firstInput, outboundDate) && dateInputMatches(secondInput, returnDate)) {
        console.log('[Renfe] Dates already set correctly — skipping');
        return;
      }
    } else {
      if (dateInputMatches(firstInput, outboundDate)) {
        console.log('[Renfe] Outbound date already set correctly — skipping');
        return;
      }
    }

    // Click the date input to open the picker
    const dateInput = firstInput || $(SEL.dateTripInput);
    if (!dateInput) throw new Error('Date input not found');

    dateInput.click();
    await delay(800);

    // Explicitly select trip mode
    if (isRoundTrip) {
      const roundTripLabel = $(SEL.tripRoundLabel);
      if (roundTripLabel) {
        roundTripLabel.click();
        console.log('[Renfe] Selected round-trip mode');
        await delay(500);
      }
    } else {
      const oneWayLabel = $(SEL.tripGoLabel);
      if (oneWayLabel) {
        oneWayLabel.click();
        console.log('[Renfe] Selected one-way mode');
        await delay(500);
      }
    }

    // --- Select outbound date ---
    await navigateToMonthVisible(outboundDate.month, outboundDate.year);
    await delay(300);
    await clickDay(outboundDate.day, outboundDate.month, outboundDate.year);
    console.log(`[Renfe] Outbound date selected: ${outboundDate.day}/${outboundDate.month}/${outboundDate.year}`);

    // --- Select return date if round-trip ---
    if (isRoundTrip) {
      await delay(300);
      await navigateToMonthVisible(returnDate.month, returnDate.year);
      await delay(300);
      await clickDay(returnDate.day, returnDate.month, returnDate.year);
      console.log(`[Renfe] Return date selected: ${returnDate.day}/${returnDate.month}/${returnDate.year}`);
    }

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
      throw new Error(`Could not read current passenger count. Button text: "${btnText}"`);
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

  /**
   * Check login and show error dialog if not logged in.
   * Returns true if logged in, false if not (and error was shown).
   */
  async function requireLogin(stepName) {
    // Login detection only works on www.renfe.com — on venta.renfe.com
    // the DOM is different and gives false negatives. Since you can only
    // reach venta.renfe.com by passing the search page (which checks login),
    // skip the check there.
    if (window.location.hostname === 'venta.renfe.com') return true;

    if (!isLoggedIn()) {
      chrome.runtime.sendMessage({
        type: 'SHOW_ERROR',
        error: 'No active session on Renfe. Log in first and try again.'
      });
      await setState('DONE');
      return false;
    }
    return true;
  }

  // --- Fill search form (main orchestrator) -----------------------------------

  async function fillSearchForm(outboundDate, returnDate, passengerCount, direction) {
    await waitForLoading();
    dismissPopups();

    await waitForDomSettle(document.body, 500, 10000);

    // Check for active session
    if (!await requireLogin('FILL_SEARCH_FORM')) return;

    // Pick station config based on direction
    // "from_hel" → outbound: Hellín → Albacete (CFG.go)
    // "from_ab"  → outbound: Albacete → Hellín (CFG.return)
    const stationCfg = direction === 'from_ab' ? CFG.return : CFG.go;

    try {
      // 1. Select origin station
      console.log('[Renfe] Step 1: Selecting origin station...');
      await selectStation(
        SEL.originInput,
        SEL.originDropdown,
        stationCfg.origin.searchText,
        stationCfg.origin.stationName
      );

      // 2. Select destination station
      console.log('[Renfe] Step 2: Selecting destination station...');
      await selectStation(
        SEL.destinationInput,
        SEL.destinationDropdown,
        stationCfg.destination.searchText,
        stationCfg.destination.stationName
      );

      // 3. Select dates
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

  // --- Trip selection ---------------------------------------------------------

  /**
   * Parse departure time from a train row's aria-label.
   * The span inside the first child div has aria-label like:
   *   "Tren con salida a las hh:mm y llegada a..."
   * Returns the hour as an integer, or null if unparseable.
   */
  function getTrainDepartureHour(trainEl) {
    const firstDiv = trainEl.querySelector('div');
    if (!firstDiv) return null;
    const span = firstDiv.querySelector('span[aria-label]');
    if (!span) return null;
    const label = span.getAttribute('aria-label') || '';
    const m = label.match(/salida a las (\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10);
  }

  /**
   * Determine if a train is "morning" or "evening" based on departure hour.
   * Before 13:00 = morning, 13:00+ = evening.
   */
  function trainTimeCategory(trainEl) {
    const hour = getTrainDepartureHour(trainEl);
    if (hour === null) return null;
    return hour < 13 ? 'morning' : 'evening';
  }

  /**
   * Select a trip (outbound or return) on the results page.
   * @param {string} timePreference - 'morning' or 'evening'
   * @param {string} leg - 'outbound' or 'return' (for error messages)
   */
  async function selectTrip(timePreference, leg) {
    // outbound uses "i" (ida), return uses "v" (vuelta)
    const prefix = leg === 'return' ? 'v' : 'i';

    // Wait for train list to appear
    const train1 = await waitFor(
      () => document.querySelector(`#tren_${prefix}_1`), 15000
    ).catch(() => { throw new Error(`No trains found for ${leg} trip.`); });
    const train2 = document.querySelector(`#tren_${prefix}_2`);

    // Build list of available trains with their time categories
    const trains = [];
    trains.push({ el: train1, category: trainTimeCategory(train1), id: `tren_${prefix}_1` });
    if (train2) {
      trains.push({ el: train2, category: trainTimeCategory(train2), id: `tren_${prefix}_2` });
    }

    console.log(`[Renfe] Found ${trains.length} train(s) for ${leg}:`,
      trains.map(t => `${t.id} → ${t.category}`).join(', '));

    // Find the matching train
    const match = trains.find(t => t.category === timePreference);
    if (!match) {
      const available = trains.map(t => `${t.id} (${t.category})`).join(', ');
      throw new Error(`No ${timePreference} train available for ${leg}. Available: ${available}`);
    }

    // Verify we could read the time for the matched train
    if (match.category === null) {
      throw new Error(`Could not determine departure time for ${match.id} on ${leg} trip.`);
    }

    console.log(`[Renfe] Selecting ${match.id} (${match.category}) for ${leg}`);

    // Click the train row's first child to expand it
    const clickTarget = match.el.firstElementChild || match.el;
    clickTarget.click();
    await delay(1000);

    // Click the fare div with data-cod-tarifa="N1010"
    const fareDiv = match.el.querySelector('div[data-cod-tarifa="N1010"]');
    if (!fareDiv) {
      throw new Error(`Fare N1010 not found inside ${match.id}. Check available fares.`);
    }
    fareDiv.click();
    console.log(`[Renfe] Selected fare N1010 on ${match.id}`);
    await delay(500);

    // Click the confirm button
    const selectBtn = document.querySelector('#btnSeleccionar');
    if (!selectBtn) {
      throw new Error('btnSeleccionar button not found');
    }
    selectBtn.click();
    console.log(`[Renfe] Confirmed ${leg} trip selection`);
    await delay(500);

    // Optionally dismiss popup (may appear after clicking btnSeleccionar)
    const popupCloseBtn = document.querySelector('#modalInciConf_i_1 button.close.close-editado');
    if (popupCloseBtn) {
      popupCloseBtn.click();
      console.log('[Renfe] Dismissed trip selection popup');
      await delay(500);
    }
  }

  async function selectOutboundTrain(outboundTime, returnTime) {
    try {
      if (!await requireLogin('SELECT_OUTBOUND_TRAIN')) return;

      const data = await chrome.storage.session.get(['returnDate']);
      const isRoundTrip = !!data.returnDate;

      if (!isRoundTrip) {
        // One-way: clicking btnSeleccionar will navigate to the traveller page
        // immediately, so pre-set the state before the page unloads.
        await setState('SELECT_TRAVELLERS');
        await selectTrip(outboundTime, 'outbound');
        // Page navigates — code below may not execute.
      } else {
        await selectTrip(outboundTime, 'outbound');
        // Return trip list loads on the same page — wait for it to refresh
        console.log('[Renfe] Waiting for return trip list to load...');
        await selectTrip(returnTime, 'return');
        await setState('SELECT_TRAVELLERS');
      }
    } catch (err) {
      console.error('[Renfe] selectOutboundTrain error:', err);
      await fail('SELECT_OUTBOUND_TRAIN', err.message);
    }
  }

  // --- Traveller profile selection --------------------------------------------

  /**
   * Find the option in a <select> whose text contains the given matchText.
   * Returns the option's value, or null if not found.
   */
  function findProfileOption(selectEl, matchText) {
    const needle = matchText.toUpperCase();
    for (const opt of selectEl.options) {
      const text = opt.textContent.replace(/\s+/g, ' ').trim().toUpperCase();
      if (text.includes(needle)) {
        return opt.value;
      }
    }
    return null;
  }

  /**
   * Select a traveller profile in a single passenger slot.
   * @param {number} idx - 0-indexed passenger slot
   * @param {string} travellerKey - 'me', 'dad', or 'mom'
   */
  async function selectTravellerProfile(idx, travellerKey) {
    const profile = PROFILES[travellerKey];
    if (!profile) throw new Error(`Unknown traveller key: "${travellerKey}"`);

    // Expand the collapsible section if collapsed
    const toggleBtn = document.querySelector(`#butonDatosPersonales${idx}`);
    if (toggleBtn && toggleBtn.getAttribute('aria-expanded') === 'false') {
      toggleBtn.click();
      console.log(`[Renfe] Expanded passenger ${idx} section`);
      await delay(800);
    }

    // Find the profile dropdown
    const select = document.querySelector(`#viajeroFrecuente${idx}`);
    if (!select) throw new Error(`Profile dropdown not found: #viajeroFrecuente${idx}`);

    // Find the matching option
    const optionValue = findProfileOption(select, profile.matchText);
    if (optionValue === null) {
      throw new Error(`Profile "${travellerKey}" (${profile.matchText}) not found in dropdown #viajeroFrecuente${idx}`);
    }

    // Check if already selected
    if (select.value === optionValue) {
      console.log(`[Renfe] Passenger ${idx}: "${travellerKey}" already selected — skipping`);
      return;
    }

    // Select the profile
    select.value = optionValue;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    console.log(`[Renfe] Passenger ${idx}: selected "${travellerKey}" (value=${optionValue})`);

    // Wait for form fields to populate — watch DOM until mutations settle
    await waitForDomSettle(document.body, 500, 15000);
  }

  async function selectTravellers(travellers) {
    try {
      await waitFor(() => document.querySelector('#butonDatosPersonales0'), 15000);
      if (!await requireLogin('SELECT_TRAVELLERS')) return;

      for (let i = 0; i < travellers.length; i++) {
        await selectTravellerProfile(i, travellers[i]);
      }

      console.log('[Renfe] All traveller profiles selected');

      // Click continue button
      const submitBtn = document.querySelector('#submitpersonaliza');
      if (!submitBtn) throw new Error('Continue button #submitpersonaliza not found');
      submitBtn.click();
      console.log('[Renfe] Clicked continue on traveller page');

      await setState('SKIP_UPSELL');
    } catch (err) {
      console.error('[Renfe] selectTravellers error:', err);
      await fail('SELECT_TRAVELLERS', err.message);
    }
  }

  // --- Upsell skip (pet transport, bike room, etc.) ---------------------------

  async function skipUpsell() {
    try {
      if (!await requireLogin('SKIP_UPSELL')) return;

      // Wait for the continue button to appear
      const submitBtn = await waitFor(
        () => document.querySelector('#submitFormaPago'),
        15000
      );
      submitBtn.click();
      console.log('[Renfe] Skipped upsell page');

      await setState('SELECT_PAYMENT');
    } catch (err) {
      console.error('[Renfe] skipUpsell error:', err);
      await fail('SKIP_UPSELL', err.message);
    }
  }

  async function selectPayment() {
    try {
      if (!await requireLogin('SELECT_PAYMENT')) return;

      // 1. Select payment method (Tarjeta Renfe radio button)
      const radio = await waitFor(
        () => document.querySelector('#datosPago_cdgoFormaPago_tarjetaRenfe'),
        15000
      );
      if (!radio.checked) {
        radio.click();
        console.log('[Renfe] Selected Tarjeta Renfe payment method');
        await delay(500);
      } else {
        console.log('[Renfe] Tarjeta Renfe already selected');
      }

      // 2. Ensure both checkboxes are checked (don't toggle — only click if unchecked)
      const checkbox1 = document.querySelector('#whatsappTicketNotification');
      if (checkbox1 && !checkbox1.checked) {
        checkbox1.click();
        console.log('[Renfe] Checked WhatsApp notification checkbox');
        await delay(300);
      }

      const checkbox2 = document.querySelector('#aceptarCondiciones');
      if (!checkbox2) throw new Error('Conditions checkbox #aceptarCondiciones not found');
      if (!checkbox2.checked) {
        checkbox2.click();
        console.log('[Renfe] Checked conditions checkbox');
        await delay(300);
      }

      // 3. Click the pay button
      const payBtn = document.querySelector('#butonPagar');
      if (!payBtn) throw new Error('Pay button #butonPagar not found');
      payBtn.click();
      console.log('[Renfe] Clicked pay button');

      await setState('AWAIT_CONFIRMATION');
    } catch (err) {
      console.error('[Renfe] selectPayment error:', err);
      await fail('SELECT_PAYMENT', err.message);
    }
  }

  async function awaitConfirmation() {
    await setState('POST_PURCHASE');
    await postPurchase();
  }

  async function postPurchase() {
    try {
      const emailInput = await waitFor(
        () => document.querySelector('#emailPassbook_1'),
        15000
      );
      emailInput.value = 'jorgequim5@hotmail.com';
      emailInput.dispatchEvent(new Event('input', { bubbles: true }));
      emailInput.dispatchEvent(new Event('change', { bubbles: true }));
      console.log('[Renfe] Entered e-mail for ticket delivery');

      await delay(300);

      const sendBtn = document.querySelector('#enviarPassbook_1');
      if (!sendBtn) throw new Error('Send button #enviarPassbook_1 not found');
      sendBtn.click();
      console.log('[Renfe] Clicked send ticket button');

      await setState('DONE');
    } catch (err) {
      console.error('[Renfe] postPurchase error:', err);
      await fail('POST_PURCHASE', err.message);
    }
  }

  // --- Main state machine ----------------------------------------------------

  async function run() {
    const data = await chrome.storage.session.get([
      'renfeState', 'outboundDate', 'returnDate', 'outboundTime', 'returnTime',
      'passengerCount', 'travellers', 'direction'
    ]);

    const state = data.renfeState;
    if (!state || state === 'DONE' || state === 'ERROR') {
      return;
    }

    console.log(`[Renfe] Running state: ${state}`, data);

    // Post-search states only run on venta.renfe.com — if we're elsewhere
    // (e.g. redirected through queue-it.net or back to www.renfe.com),
    // skip and let the state persist until we land on the right page.
    const postSearchStates = [
      'SELECT_OUTBOUND_TRAIN', 'SELECT_TRAVELLERS', 'SKIP_UPSELL',
      'SELECT_PAYMENT', 'AWAIT_CONFIRMATION', 'POST_PURCHASE'
    ];
    if (postSearchStates.includes(state) && window.location.hostname !== 'venta.renfe.com') {
      console.log(`[Renfe] State ${state} requires venta.renfe.com, currently on ${window.location.hostname} — waiting for redirect`);
      return;
    }

    dismissPopups();

    switch (state) {
      case 'OPEN_RENFE':
        await setState('FILL_SEARCH_FORM');
        await fillSearchForm(data.outboundDate, data.returnDate, data.passengerCount || 1, data.direction);
        break;

      case 'FILL_SEARCH_FORM':
        await fillSearchForm(data.outboundDate, data.returnDate, data.passengerCount || 1, data.direction);
        break;

      case 'SELECT_OUTBOUND_TRAIN':
        await selectOutboundTrain(data.outboundTime || 'morning', data.returnTime || 'evening');
        break;

      case 'SELECT_TRAVELLERS':
        await selectTravellers(data.travellers || []);
        break;

      case 'SKIP_UPSELL':
        await skipUpsell();
        break;

      case 'SELECT_PAYMENT':
        await selectPayment();
        break;

      case 'AWAIT_CONFIRMATION':
        await awaitConfirmation();
        break;

      case 'POST_PURCHASE':
        await postPurchase();
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
