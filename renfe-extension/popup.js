// ============================================================
// POPUP SCRIPT — Booking status + Recorder controls
// ============================================================

// --- Booking status ---------------------------------------------------------

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
  SELECT_PAYMENT: 'Seleccionando pago…',
  AWAIT_CONFIRMATION: '¡Listo! Confirma manualmente',
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

// --- Recorder controls ------------------------------------------------------

const recDot = document.getElementById('rec-dot');
const recStart = document.getElementById('rec-start');
const recStop = document.getElementById('rec-stop');
const recClear = document.getElementById('rec-clear');
const eventCount = document.getElementById('event-count');
const statusMsg = document.getElementById('status-msg');
const stepLabel = document.getElementById('step-label');
const savedFilesEl = document.getElementById('saved-files');

let isRecording = false;

async function sendToContent(msg) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  return chrome.tabs.sendMessage(tab.id, msg);
}

function setRecordingUI(active) {
  isRecording = active;
  recDot.classList.toggle('active', active);
  recStart.disabled = active;
  recStop.disabled = !active;
  stepLabel.disabled = active;
}

async function refreshEventCount() {
  const data = await chrome.storage.session.get(['recorderEvents']);
  const count = (data.recorderEvents || []).length;
  eventCount.textContent = `${count} event${count !== 1 ? 's' : ''}`;
  return data.recorderEvents || [];
}

async function refreshSavedFiles() {
  const data = await chrome.storage.local.get(['recorderSavedFiles']);
  const files = data.recorderSavedFiles || [];
  if (files.length === 0) {
    savedFilesEl.innerHTML = '';
    return;
  }
  savedFilesEl.innerHTML = '<strong>Saved recordings:</strong>' +
    files.map(f => `<div>${f}</div>`).join('');
}

// Start recording
recStart.addEventListener('click', async () => {
  const label = stepLabel.value.trim();
  if (!label) {
    statusMsg.textContent = 'Enter a step label first!';
    statusMsg.style.color = '#991b1b';
    stepLabel.focus();
    return;
  }
  await chrome.storage.session.set({
    recorderActive: true,
    recorderStepLabel: label
  });
  await sendToContent({ type: 'RECORDER_START' });
  setRecordingUI(true);
  statusMsg.style.color = '#065f46';
  statusMsg.textContent = 'Recording… interact with the page.';
});

// Stop recording & auto-save to disk
recStop.addEventListener('click', async () => {
  await chrome.storage.session.set({ recorderActive: false });
  const resp = await sendToContent({ type: 'RECORDER_STOP' });
  setRecordingUI(false);

  const count = resp?.eventCount || 0;
  statusMsg.textContent = `Stopped. ${count} events. Saving to file…`;

  // Get events and send to background to save as a download
  const events = await refreshEventCount();
  const label = stepLabel.value.trim() || 'unnamed_step';

  if (events.length > 0) {
    const saveResp = await chrome.runtime.sendMessage({
      type: 'RECORDER_SAVE_TO_DISK',
      stepLabel: label,
      events: events,
    });

    if (saveResp?.ok) {
      statusMsg.style.color = '#065f46';
      statusMsg.textContent = `Saved: ${saveResp.filename}`;

      // Track saved files list in persistent storage
      const stored = await chrome.storage.local.get(['recorderSavedFiles']);
      const files = stored.recorderSavedFiles || [];
      if (!files.includes(saveResp.filename)) {
        files.push(saveResp.filename);
        await chrome.storage.local.set({ recorderSavedFiles: files });
      }
      refreshSavedFiles();
    } else {
      statusMsg.style.color = '#991b1b';
      statusMsg.textContent = `Save failed: ${saveResp?.error || 'unknown error'}`;
    }
  } else {
    statusMsg.textContent = 'No events to save.';
  }
});

// Clear
recClear.addEventListener('click', async () => {
  await sendToContent({ type: 'RECORDER_CLEAR' });
  await chrome.storage.session.remove(['recorderEvents']);
  statusMsg.textContent = 'Cleared.';
  refreshEventCount();
});

// --- Init -------------------------------------------------------------------

refreshStatus();
refreshEventCount();
refreshSavedFiles();

chrome.storage.session.get(['recorderActive', 'recorderStepLabel'], (data) => {
  if (data.recorderActive) {
    setRecordingUI(true);
    statusMsg.textContent = 'Recording in progress…';
  }
  if (data.recorderStepLabel) {
    stepLabel.value = data.recorderStepLabel;
  }
});

chrome.storage.onChanged.addListener(() => {
  refreshStatus();
  refreshEventCount();
});
