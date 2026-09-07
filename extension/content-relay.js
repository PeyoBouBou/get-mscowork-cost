// Relais entre le hook injecte dans la page et le service worker.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== 'copilot-credits-monitor' || !data.token) return;

  try {
    chrome.runtime.sendMessage({ type: 'captured', token: data.token, url: data.url });
  } catch {
    /* contexte d'extension invalide (rechargement) */
  }
});
