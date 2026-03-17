const params = new URLSearchParams(window.location.search);
const msg = params.get('msg') || 'Unknown error';
const msgEl = document.getElementById('msg');

if (msg.startsWith('Usage:')) {
  const prefix = document.createElement('span');
  prefix.textContent = 'Usage: ';
  prefix.style.userSelect = 'none';
  const rest = document.createTextNode(msg.substring('Usage: '.length));
  msgEl.appendChild(prefix);
  msgEl.appendChild(rest);
} else {
  msgEl.textContent = msg;
}

document.getElementById('ok').addEventListener('click', () => history.back());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || e.key === 'Enter') history.back();
});
