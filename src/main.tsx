import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Offline precaching downloads the whole app shell; registering after the load
 * event keeps that traffic off the critical path of first paint.
 */
function registerServiceWorker() {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}

/**
 * Precaching fetches the whole app shell (hundreds of kilobytes). Registering
 * during load competes with the scripts that paint the first screen, so the
 * registration waits for an idle window once the page is interactive.
 */
const idle: (callback: () => void) => void =
  typeof window.requestIdleCallback === 'function'
    ? (callback) => window.requestIdleCallback(callback, { timeout: 3000 })
    : (callback) => window.setTimeout(callback, 1200);

if (document.readyState === 'complete') {
  idle(registerServiceWorker);
} else {
  window.addEventListener('load', () => idle(registerServiceWorker), { once: true });
}
