/**
 * Renderer entry. The view (main window or tray panel) comes from the preload
 * (`window.yami.view`); `?view=tray` is only a fallback for inspection without it.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { detectLocale, translatorFor } from '../shared/i18n/catalog.ts';
import { localeTag } from './shared/i18n/format.ts';
import { Root } from './app/Root.tsx';
import './styles/globals.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

const api = typeof window.yami === 'object' && window.yami !== null ? window.yami : null;
const view = api?.view ?? (new URLSearchParams(window.location.search).get('view') === 'tray' ? 'tray' : 'main');

if (view === 'tray') {
  document.documentElement.classList.add('tray-popup');
  document.body.classList.add('overflow-hidden');
}

if (api) {
  createRoot(container).render(
    <StrictMode>
      <Root api={api} view={view} />
    </StrictMode>
  );
} else {
  // Opened outside Electron (no preload bridge): show a static, localized notice.
  const locale = detectLocale(navigator.language);
  document.documentElement.lang = localeTag(locale);
  const message = document.createElement('p');
  message.className = 'm-0 p-8 text-sm text-text-3';
  message.textContent = translatorFor(locale).t('ui.app.bridgeMissing');
  container.replaceChildren(message);
}
