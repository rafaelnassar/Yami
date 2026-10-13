/**
 * Locale detection, copy, and latest GitHub release links.
 */
(() => {
  const OWNER = 'rafaelnassar';
  const REPO = 'Yami';
  const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases/latest`;
  const API_URL = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

  /** @typedef {'pt' | 'en' | 'es'} Locale */

  /** @type {Record<Locale, Record<string, string>>} */
  const MESSAGES = {
    pt: {
      lang: 'pt-BR',
      description: 'Yami — interface desktop para gallery-dl e yt-dlp: fila, biblioteca e notificações.',
      ogDescription: 'Interface desktop para gallery-dl e yt-dlp.',
      ledeHtml:
        'Interface para <span class="lede__em">gallery-dl</span> e <span class="lede__em">yt-dlp</span> — fila, biblioteca e notificações nativas.',
      chipQueue: 'Fila com retentativas',
      chipLibrary: 'Biblioteca local',
      chipPreview: 'Preview de mídia',
      chipsLabel: 'Recursos',
      actionsLabel: 'Downloads e código',
      windows: 'Windows',
      linux: 'Linux',
      github: 'GitHub',
      download: 'Baixar',
      versionFallback: '…',
      linuxMissing: 'Linux: AppImage ainda não publicado nesta release.',
      assetUnavailableTitle: 'Ainda sem instalador nesta release — abre a página de releases',
      previewLabel: 'Prévia do aplicativo',
      previewAlt: 'Interface do Yami'
    },
    en: {
      lang: 'en',
      description: 'Yami — desktop UI for gallery-dl and yt-dlp: queue, library, and notifications.',
      ogDescription: 'Desktop UI for gallery-dl and yt-dlp.',
      ledeHtml:
        'Desktop UI for <span class="lede__em">gallery-dl</span> and <span class="lede__em">yt-dlp</span> — queue, library, and native notifications.',
      chipQueue: 'Queue with retries',
      chipLibrary: 'Local library',
      chipPreview: 'Media preview',
      chipsLabel: 'Features',
      actionsLabel: 'Downloads and code',
      windows: 'Windows',
      linux: 'Linux',
      github: 'GitHub',
      download: 'Download',
      versionFallback: '…',
      linuxMissing: 'Linux: AppImage not published in this release yet.',
      assetUnavailableTitle: 'No installer in this release yet — opens the releases page',
      previewLabel: 'App preview',
      previewAlt: 'Yami interface'
    },
    es: {
      lang: 'es',
      description: 'Yami — interfaz de escritorio para gallery-dl y yt-dlp: cola, biblioteca y notificaciones.',
      ogDescription: 'Interfaz de escritorio para gallery-dl y yt-dlp.',
      ledeHtml:
        'Interfaz para <span class="lede__em">gallery-dl</span> y <span class="lede__em">yt-dlp</span> — cola, biblioteca y notificaciones nativas.',
      chipQueue: 'Cola con reintentos',
      chipLibrary: 'Biblioteca local',
      chipPreview: 'Vista previa',
      chipsLabel: 'Funciones',
      actionsLabel: 'Descargas y código',
      windows: 'Windows',
      linux: 'Linux',
      github: 'GitHub',
      download: 'Descargar',
      versionFallback: '…',
      linuxMissing: 'Linux: AppImage aún no publicado en esta release.',
      assetUnavailableTitle: 'Sin instalador en esta release — abre la página de releases',
      previewLabel: 'Vista previa de la app',
      previewAlt: 'Interfaz de Yami'
    }
  };

  /** @returns {Locale} */
  function detectLocale() {
    const candidates = [...(navigator.languages || []), navigator.language || 'en'];
    for (const raw of candidates) {
      const code = String(raw).toLowerCase().split('-')[0];
      if (code === 'pt' || code === 'es' || code === 'en') return code;
    }
    return 'en';
  }

  /** @param {Locale} locale */
  function applyLocale(locale) {
    const t = MESSAGES[locale];
    document.documentElement.lang = t.lang;

    const desc = document.querySelector('meta[name="description"]');
    if (desc) desc.setAttribute('content', t.description);
    const ogDesc = document.querySelector('meta[property="og:description"]');
    if (ogDesc) ogDesc.setAttribute('content', t.ogDescription);

    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      if (key === 'lede') {
        el.innerHTML = t.ledeHtml;
        return;
      }
      if (!(key in t)) return;
      el.textContent = t[key];
    });

    document.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      const key = el.getAttribute('data-i18n-aria');
      if (!key || !(key in t)) return;
      el.setAttribute('aria-label', t[key]);
    });

    document.querySelectorAll('[data-i18n-alt]').forEach((el) => {
      const key = el.getAttribute('data-i18n-alt');
      if (!key || !(key in t)) return;
      el.setAttribute('alt', t[key]);
    });

    return t;
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  function isWinSetup(name) {
    return /^Yami-Setup-.*-x64\.exe$/i.test(name);
  }

  /**
   * @param {string} name
   * @returns {boolean}
   */
  function isLinuxAppImage(name) {
    return /^Yami-.*-x64\.AppImage$/i.test(name);
  }

  /**
   * @param {HTMLAnchorElement | null} button
   * @param {string | undefined} url
   * @param {boolean} available
   * @param {string} unavailableTitle
   */
  function applyLink(button, url, available, unavailableTitle) {
    if (!button) return;
    if (available && url) {
      button.href = url;
      button.removeAttribute('title');
      return;
    }
    button.href = RELEASES_URL;
    button.title = unavailableTitle;
  }

  /**
   * @param {string} tag
   * @returns {string}
   */
  function formatVersion(tag) {
    const cleaned = String(tag).trim();
    if (!cleaned) return '';
    return cleaned.startsWith('v') || cleaned.startsWith('V') ? cleaned : `v${cleaned}`;
  }

  async function loadLatestRelease(t) {
    const winBtn = document.getElementById('download-windows');
    const linuxBtn = document.getElementById('download-linux');
    const versionLabel = document.getElementById('version-label');
    const status = document.getElementById('download-status');

    try {
      const response = await fetch(API_URL, {
        headers: { Accept: 'application/vnd.github+json' }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const release = await response.json();
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const win = assets.find((asset) => isWinSetup(asset.name));
      const linux = assets.find((asset) => isLinuxAppImage(asset.name));

      applyLink(
        /** @type {HTMLAnchorElement | null} */ (winBtn),
        win?.browser_download_url,
        Boolean(win),
        t.assetUnavailableTitle
      );
      applyLink(
        /** @type {HTMLAnchorElement | null} */ (linuxBtn),
        linux?.browser_download_url,
        Boolean(linux),
        t.assetUnavailableTitle
      );

      if (versionLabel && release.tag_name) {
        versionLabel.textContent = formatVersion(release.tag_name);
      }

      if (status) {
        status.textContent = win && !linux ? t.linuxMissing : '';
      }
    } catch {
      applyLink(/** @type {HTMLAnchorElement | null} */ (winBtn), RELEASES_URL, true, '');
      applyLink(/** @type {HTMLAnchorElement | null} */ (linuxBtn), RELEASES_URL, true, '');
      if (status) status.textContent = '';
    }
  }

  const locale = detectLocale();
  const t = applyLocale(locale);
  loadLatestRelease(t);
})();
