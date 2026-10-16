/**
 * In-page indicator shown while the agent controls the tab. Runs as a
 * content script (isolated world), injected only into tabs the agent acts
 * on. It lives in a closed shadow root on <html>, is hidden from the
 * accessibility tree, never takes pointer events except on its button, and
 * uses fixed positioning so it cannot change the page layout.
 */
import type { OverlayMessage } from '../background/overlay.ts';

declare global {
  interface Window {
    __neoWebmcpOverlay?: boolean;
  }
}

if (!window.__neoWebmcpOverlay) {
  window.__neoWebmcpOverlay = true;

  let host: HTMLElement | null = null;
  let label: HTMLElement;
  let button: HTMLButtonElement;
  let frame: HTMLElement;
  let state: OverlayMessage = { neo: 'overlay', action: 'hide' };
  let suspended = false;

  const build = () => {
    host = document.createElement('neo-webmcp-indicator');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        .frame { position: fixed; inset: 0; pointer-events: none; border: 3px solid rgba(124, 58, 237, .85);
          box-shadow: inset 0 0 18px rgba(124, 58, 237, .55); border-radius: 4px; animation: pulse 2.4s ease-in-out infinite; }
        .frame.paused { border-color: rgba(217, 119, 6, .9); box-shadow: inset 0 0 18px rgba(217, 119, 6, .5); animation: none; }
        .pill { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); pointer-events: none; display: flex; gap: 10px; align-items: center;
          font: 600 12px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; color: #fff; background: rgba(30, 27, 75, .92);
          padding: 6px 6px 6px 12px; border-radius: 999px; box-shadow: 0 4px 16px rgba(0,0,0,.3); user-select: none; }
        .pill.paused { background: rgba(120, 53, 15, .95); }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #a78bfa; box-shadow: 0 0 0 0 rgba(167,139,250,.7); animation: ping 1.6s infinite; }
        .paused .dot { background: #fbbf24; animation: none; }
        /* Only the button takes pointer events: the rest of the indicator lets clicks through to the page. */
        button { all: unset; pointer-events: auto; cursor: pointer; font: 600 12px system-ui, sans-serif; color: #1e1b4b; background: #fff; padding: 4px 10px; border-radius: 999px; }
        button:hover { background: #ede9fe; }
        @keyframes pulse { 50% { border-color: rgba(167, 139, 250, .55); } }
        @keyframes ping { 70% { box-shadow: 0 0 0 7px rgba(167,139,250,0); } 100% { box-shadow: 0 0 0 0 rgba(167,139,250,0); } }
      </style>
      <div class="frame"></div>
      <div class="pill"><span class="dot"></span><span class="label"></span><button type="button"></button></div>`;
    frame = root.querySelector('.frame')!;
    label = root.querySelector('.label')!;
    button = root.querySelector('button')!;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      void chrome.runtime.sendMessage({ neo: state.paused ? 'overlay-resume' : 'overlay-stop', sessionId: state.sessionId });
    });
    document.documentElement.appendChild(host);
  };

  const render = () => {
    if (!host) return;
    const visible = !suspended && state.action === 'show';
    host.style.display = visible ? 'block' : 'none';
    if (!visible) return;
    const paused = !!state.paused;
    label.textContent = paused ? state.pausedLabel ?? '' : state.label ?? '';
    button.textContent = paused ? state.resumeLabel ?? 'Resume' : state.stopLabel ?? 'Stop';
    frame.classList.toggle('paused', paused);
    label.parentElement!.classList.toggle('paused', paused);
  };

  chrome.runtime.onMessage.addListener((msg: OverlayMessage, _sender, reply) => {
    if (msg?.neo !== 'overlay') return;
    switch (msg.action) {
      case 'show':
      case 'hide':
        state = { ...state, ...msg };
        if (msg.action === 'show' && !host) build();
        if (host && !host.isConnected) document.documentElement.appendChild(host);
        break;
      case 'suspend':
        suspended = true;
        break;
      case 'unsuspend':
        suspended = false;
        break;
      case 'remove':
        host?.remove();
        host = null;
        state = { neo: 'overlay', action: 'hide' };
        break;
    }
    render();
    // Answer synchronously so "suspend" is applied before the screenshot is taken.
    reply(true);
  });
}
