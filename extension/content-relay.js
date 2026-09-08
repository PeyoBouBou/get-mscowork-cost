// Relais entre le hook injecte dans la page et le service worker.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'copilot-credits-monitor') return;

  try {
    if (data.token) {
      chrome.runtime.sendMessage({ type: 'captured', token: data.token, url: data.url });
    } else if (data.url) {
      // Endpoint runtime observe (hote variable selon le tenant).
      chrome.runtime.sendMessage({ type: 'endpoint-seen', url: data.url });
    }
  } catch {
    /* contexte d'extension invalide (rechargement) */
  }
});
