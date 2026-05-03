// アプリ内ダイアログ（alert / confirm / prompt の代替）
// すべて Promise を返す。デバイス標準の UI に依存しない。

let host = null;

function ensureHost() {
  if (host) return host;
  host = document.createElement('div');
  host.className = 'app-dialog-host';
  host.style.display = 'none';
  document.body.appendChild(host);
  return host;
}

function open(html, opts = {}) {
  const root = ensureHost();
  root.innerHTML = `<div class="app-dialog-backdrop"><div class="app-dialog-box ${opts.cls || ''}">${html}</div></div>`;
  root.style.display = 'block';

  const backdrop = root.querySelector('.app-dialog-backdrop');
  const box = root.querySelector('.app-dialog-box');

  return {
    root, backdrop, box,
    close() {
      root.style.display = 'none';
      root.innerHTML = '';
    },
  };
}

function escapeHtml(str) {
  if (str == null) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

function nl2br(str) {
  return escapeHtml(str).replace(/\n/g, '<br>');
}

// alert(message): Promise<void>
export function alert(message, { okLabel = 'OK', title = '' } = {}) {
  return new Promise((resolve) => {
    const dlg = open(`
      ${title ? `<h3 class="app-dialog-title">${escapeHtml(title)}</h3>` : ''}
      <div class="app-dialog-body">${nl2br(message)}</div>
      <div class="app-dialog-actions">
        <button class="btn btn-primary app-dialog-ok">${escapeHtml(okLabel)}</button>
      </div>
    `);
    const finish = () => { dlg.close(); resolve(); };
    dlg.box.querySelector('.app-dialog-ok').addEventListener('click', finish);
    dlg.backdrop.addEventListener('click', (e) => { if (e.target === dlg.backdrop) finish(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape' || e.key === 'Enter') {
        document.removeEventListener('keydown', onKey);
        finish();
      }
    });
    dlg.box.querySelector('.app-dialog-ok').focus();
  });
}

// confirm(message): Promise<boolean>
export function confirm(message, { okLabel = 'OK', cancelLabel = 'キャンセル', title = '', danger = false } = {}) {
  return new Promise((resolve) => {
    const dlg = open(`
      ${title ? `<h3 class="app-dialog-title">${escapeHtml(title)}</h3>` : ''}
      <div class="app-dialog-body">${nl2br(message)}</div>
      <div class="app-dialog-actions">
        <button class="btn btn-secondary app-dialog-cancel">${escapeHtml(cancelLabel)}</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'} app-dialog-ok">${escapeHtml(okLabel)}</button>
      </div>
    `);
    const finish = (v) => { dlg.close(); resolve(v); };
    dlg.box.querySelector('.app-dialog-ok').addEventListener('click', () => finish(true));
    dlg.box.querySelector('.app-dialog-cancel').addEventListener('click', () => finish(false));
    dlg.backdrop.addEventListener('click', (e) => { if (e.target === dlg.backdrop) finish(false); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); finish(false); }
      if (e.key === 'Enter') { document.removeEventListener('keydown', onKey); finish(true); }
    });
    dlg.box.querySelector('.app-dialog-ok').focus();
  });
}

// prompt(message, defaultValue): Promise<string|null>
export function prompt(message, defaultValue = '', { okLabel = 'OK', cancelLabel = 'キャンセル', title = '', placeholder = '', multiline = false, type = 'text' } = {}) {
  return new Promise((resolve) => {
    const inputHtml = multiline
      ? `<textarea class="app-dialog-input" rows="3" placeholder="${escapeHtml(placeholder)}">${escapeHtml(defaultValue)}</textarea>`
      : `<input class="app-dialog-input" type="${escapeHtml(type)}" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}" />`;
    const dlg = open(`
      ${title ? `<h3 class="app-dialog-title">${escapeHtml(title)}</h3>` : ''}
      ${message ? `<div class="app-dialog-body">${nl2br(message)}</div>` : ''}
      ${inputHtml}
      <div class="app-dialog-actions">
        <button class="btn btn-secondary app-dialog-cancel">${escapeHtml(cancelLabel)}</button>
        <button class="btn btn-primary app-dialog-ok">${escapeHtml(okLabel)}</button>
      </div>
    `);
    const input = dlg.box.querySelector('.app-dialog-input');
    const finish = (v) => { dlg.close(); resolve(v); };
    dlg.box.querySelector('.app-dialog-ok').addEventListener('click', () => finish(input.value));
    dlg.box.querySelector('.app-dialog-cancel').addEventListener('click', () => finish(null));
    dlg.backdrop.addEventListener('click', (e) => { if (e.target === dlg.backdrop) finish(null); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); finish(null); }
      if (e.key === 'Enter' && !multiline) { document.removeEventListener('keydown', onKey); finish(input.value); }
    });
    input.focus();
    if (!multiline) input.select();
  });
}

// 簡易トースト（自動消滅）
let toastHost = null;
export function toast(message, { type = 'info', timeout = 3500 } = {}) {
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.className = 'app-toast-host';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  el.className = `app-toast app-toast-${type}`;
  el.textContent = message;
  toastHost.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}
