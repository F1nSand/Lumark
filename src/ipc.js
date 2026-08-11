// window.api 的封装 + toast

export function toast(message, type = 'info', timeout = 2500) {
  const container = document.getElementById('toasts');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.classList.add('toast--out'), timeout - 300);
  setTimeout(() => el.remove(), timeout);
}

export async function safeCall(label, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(`[ipc:${label}]`, err);
    toast(err?.message || String(err), 'error', 4000);
    return null;
  }
}

export const api = window.api;

export function log(...args) {
  console.log('[renderer]', ...args);
}
