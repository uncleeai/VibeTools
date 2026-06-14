// Shared debug-panel logger (extracted from main.js).
const debugLogEl = document.getElementById('debugLog');

export function addLog(message, type) {
    if (!debugLogEl) return;
    const entry = document.createElement('div');
    entry.className = 'log-entry' + (type ? ' log-' + type : '');
    entry.textContent = new Date().toLocaleTimeString() + ': ' + message;
    debugLogEl.appendChild(entry);
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
}
