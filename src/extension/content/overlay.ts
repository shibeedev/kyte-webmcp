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
    __kyteWebmcpOverlay?: boolean;
  }
}

if (!window.__kyteWebmcpOverlay) {
  window.__kyteWebmcpOverlay = true;

  let host: HTMLElement | null = null;
  let label: HTMLElement;
  let button: HTMLButtonElement;
  let frame: HTMLElement;
  let state: OverlayMessage = { kyte: 'overlay', action: 'hide' };
  let suspended = false;

  const build = () => {
    host = document.createElement('kyte-webmcp-indicator');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; display: none;';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        /* macOS look: a focus-ring style border in the system blue and a translucent dark HUD. */
        .frame { position: fixed; inset: 0; pointer-events: none; border: 3px solid rgba(0, 122, 255, .85);
          box-shadow: inset 0 0 16px rgba(0, 122, 255, .35); border-radius: 6px; animation: pulse 2.4s ease-in-out infinite; }
        .frame.paused { border-color: rgba(255, 149, 0, .9); box-shadow: inset 0 0 16px rgba(255, 149, 0, .35); animation: none; }
        .pill { position: fixed; top: 10px; left: 50%; transform: translateX(-50%); pointer-events: none; display: flex; gap: 9px; align-items: center;
          font: 500 12px/1.2 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif;
          color: rgba(255, 255, 255, .92); background: rgba(30, 30, 32, .78); backdrop-filter: saturate(180%) blur(20px);
          padding: 5px 5px 5px 11px; border-radius: 12px; border: .5px solid rgba(255, 255, 255, .16);
          box-shadow: 0 10px 28px rgba(0, 0, 0, .28), 0 0 0 .5px rgba(0, 0, 0, .35); user-select: none; -webkit-font-smoothing: antialiased; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: #0a84ff; box-shadow: 0 0 0 0 rgba(10, 132, 255, .7); animation: ping 1.6s infinite; }
        .paused .dot { background: #ff9f0a; animation: none; }
        /* Only the button takes pointer events: the rest of the indicator lets clicks through to the page. */
        button { all: unset; pointer-events: auto; cursor: pointer; font: 500 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
          color: #fff; background: #ff453a; padding: 5px 11px; border-radius: 7px; box-shadow: 0 .5px 1px rgba(0, 0, 0, .3); }
        button:hover { filter: brightness(1.08); }
        .paused button { background: #0a84ff; }
        @keyframes pulse { 50% { border-color: rgba(0, 122, 255, .5); } }
        @keyframes ping { 70% { box-shadow: 0 0 0 7px rgba(10, 132, 255, 0); } 100% { box-shadow: 0 0 0 0 rgba(10, 132, 255, 0); } }
      </style>
      <div class="frame"></div>
      <div class="pill"><span class="dot"></span><span class="label"></span><button type="button"></button></div>`;
    frame = root.querySelector('.frame')!;
    label = root.querySelector('.label')!;
    button = root.querySelector('button')!;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      void chrome.runtime.sendMessage({ kyte: state.paused ? 'overlay-resume' : 'overlay-stop', sessionId: state.sessionId });
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
    if (msg?.kyte !== 'overlay') return;
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
        state = { kyte: 'overlay', action: 'hide' };
        break;
    }
    render();
    // Answer synchronously so "suspend" is applied before the screenshot is taken.
    reply(true);
  });
}
