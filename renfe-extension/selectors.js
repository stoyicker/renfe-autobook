// ============================================================
// DOM SELECTORS — All from recorder observations
// ============================================================
// Update these when Renfe changes their frontend.
// ============================================================

const SELECTORS = {
  // --- Station autocomplete ---
  originInput: '#origin',
  destinationInput: '#destination',
  // Awesomplete dropdown lists (origin = list_1, destination = list_2)
  originDropdown: '#awesomplete_list_1',
  destinationDropdown: '#awesomplete_list_2',
  // Individual dropdown items (role="option" li elements)
  autocompleteItem: 'li[role="option"]',

  // --- Passenger picker ---
  passengersButton: '#passengersSelection',
  passengersList: '#passengersSelectionList',
  // Plus button: second button inside the counter div of the first list item
  passengerPlusBtn: '#passengersSelectionList > ul > li:first-child > div.rf-passengers-alternative__counter > button:nth-child(3)',
  // Icon inside plus button (sometimes the click target)
  passengerPlusIcon: '#passengersSelectionList i.icon-more',
  // Counter display (shows current number between - and + buttons)
  passengerCountDisplay: '#passengersSelectionList > ul > li:first-child > div.rf-passengers-alternative__counter > button:nth-child(2)',
  // Minus button
  passengerMinusBtn: '#passengersSelectionList > ul > li:first-child > div.rf-passengers-alternative__counter > button:nth-child(1)',
  passengerMinusIcon: '#passengersSelectionList i.icon-minus',
  // "Listo" confirm button
  passengerDoneBtn: '#passengersSelectionList button.rf-passengers-alternative__button-list--primary',

  // --- Date picker ---
  // Trigger inputs on the search bar
  dateFirstInput: '#first-input',    // "Fecha ida"
  dateSecondInput: '#second-input',  // "Fecha vuelta"
  dateTripInput: '#trip-input',      // shown in one-way mode

  // Trip type radio buttons
  tripGoRadio: '#trip-go',           // one-way (value "OW")
  tripRoundRadio: '#trip-round',     // round trip (value "RT")
  tripGoLabel: 'label[for="trip-go"]',
  tripRoundLabel: 'label[for="trip-round"]',

  // Calendar month sections
  calendarMonth: 'section.lightpick__month',
  // Month label spans (contain text like "abril2026")
  monthLabelRange: 'span.rf-daterange-alternative__month-label',
  monthLabelPicker: 'span.rf-daterange-picker-alternative__month-label',

  // Navigation arrows
  nextMonthBtn: 'button.lightpick__next-action',
  prevMonthBtn: 'button.lightpick__previous-action',

  // Day cells
  dayCell: 'div.lightpick__day',
  dayCellAvailable: 'div.lightpick__day.is-available',

  // Confirm button at the bottom of the calendar
  dateAcceptBtn: 'button.lightpick__apply-action-sub',

  // --- Search submit ---
  // The main search button (we'll need to verify this selector)
  searchBtn: 'button.rf-search-alternative__submit, button[type="submit"], .rf-btn--primary',

  // --- Cookie / popup dismissal ---
  cookieAcceptBtn: '#onetrust-accept-btn-handler',
  modalCloseButtons: [
    '.modal .close',
    '.modal-dialog .btn-close',
    '[aria-label="Cerrar"]',
    '[aria-label="Close"]',
    '.rf-modal__close',
    'button.close'
  ],

  // --- Loading indicator ---
  loadingSpinner: '.rf-loading, .spinner, .loading-overlay, [aria-busy="true"]'
};

if (typeof window !== 'undefined') {
  window.RENFE_SELECTORS = SELECTORS;
}
