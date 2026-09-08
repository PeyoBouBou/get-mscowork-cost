// Injecte dans le contexte de la page (monde MAIN) : observe les en-tetes
// Authorization envoyes par la page vers le runtime Copilot.
(() => {
  const HOST_RE = /(^|\.)gateway\.prod\.island\.powerapps\.com$/i;

  const publish = (token, url) => {
    window.postMessage(
      {
        source: 'copilot-credits-monitor',
        token: token ? String(token).replace(/^Bearer\s+/i, '') : null,
        url
      },
      '*'
    );
  };

  // Signale l'hote runtime des qu'il est vu, meme sans en-tete Authorization :
  // l'hote depend du tenant/region et doit etre decouvert dynamiquement.
  const seenUrls = new Set();
  const publishEndpoint = (url) => {
    try {
      const absolute = new URL(url, location.href);
      if (!HOST_RE.test(absolute.host) || seenUrls.has(absolute.host)) return;
      seenUrls.add(absolute.host);
      publish(null, absolute.href);
    } catch {
      /* URL inutilisable */
    }
  };

  const matches = (url) => {
    try {
      return HOST_RE.test(new URL(url, location.href).host);
    } catch {
      return false;
    }
  };

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (url && matches(url)) {
          publishEndpoint(url);
          let auth = null;
          const initHeaders = init?.headers;
          if (initHeaders instanceof Headers) auth = initHeaders.get('authorization');
          else if (Array.isArray(initHeaders)) {
            auth = initHeaders.find((h) => String(h[0]).toLowerCase() === 'authorization')?.[1];
          } else if (initHeaders && typeof initHeaders === 'object') {
            const key = Object.keys(initHeaders).find((k) => k.toLowerCase() === 'authorization');
            auth = key ? initHeaders[key] : null;
          }
          if (!auth && input instanceof Request) auth = input.headers.get('authorization');
          if (auth) publish(auth, url);
        }
      } catch {
        /* ne jamais casser la page */
      }
      return originalFetch.apply(this, arguments);
    };
  }

  const openOriginal = XMLHttpRequest.prototype.open;
  const setHeaderOriginal = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ccmUrl = url;
    try {
      publishEndpoint(url);
    } catch {
      /* ignore */
    }
    return openOriginal.apply(this, arguments);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (String(name).toLowerCase() === 'authorization' && matches(this.__ccmUrl)) {
        publish(value, this.__ccmUrl);
      }
    } catch {
      /* ignore */
    }
    return setHeaderOriginal.apply(this, arguments);
  };
})();
