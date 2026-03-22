// ============================================================
// POPUP SCRIPT — Booking status
// ============================================================

function formatDate(d) {
  if (!d) return '-';
  return `${String(d.day).padStart(2, '0')}/${String(d.month).padStart(2, '0')}/${d.year}`;
}

function stateClass(state) {
  if (!state || state === 'DONE') return 'state-done';
  if (state === 'ERROR') return 'state-error';
  if (state === 'IDLE') return 'state-idle';
  return 'state-running';
}

const STATE_LABELS = {
  OPEN_RENFE: 'Abriendo Renfe…',
  FILL_SEARCH_FORM: 'Rellenando búsqueda…',
  SELECT_OUTBOUND_TRAIN: 'Eligiendo tren de ida…',
  SELECT_RETURN_TRAIN: 'Eligiendo tren de vuelta…',
  SELECT_TRAVELLERS: 'Seleccionando viajeros…',
  SKIP_UPSELL: 'Saltando extras…',
  SELECT_PAYMENT: 'Seleccionando pago…',
  AWAIT_CONFIRMATION: 'Procesando pago…',
  POST_PURCHASE: 'Enviando billete…',
  DONE: 'Completado',
  ERROR: 'Error',
};

async function refreshStatus() {
  const data = await chrome.storage.session.get([
    'renfeState', 'outboundDate', 'returnDate'
  ]);
  const stateEl = document.getElementById('state');
  const state = data.renfeState || 'IDLE';
  stateEl.textContent = STATE_LABELS[state] || state;
  stateEl.className = stateClass(state);
  document.getElementById('outbound').textContent = formatDate(data.outboundDate);
  document.getElementById('return').textContent = formatDate(data.returnDate);
}

document.getElementById('reset-btn').addEventListener('click', async () => {
  await chrome.storage.session.remove(['renfeState', 'outboundDate', 'returnDate']);
  refreshStatus();
});

refreshStatus();

chrome.storage.onChanged.addListener(() => {
  refreshStatus();
});
