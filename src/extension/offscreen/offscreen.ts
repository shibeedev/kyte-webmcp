/**
 * Offscreen document: DOM-only work the service worker cannot do. Each
 * feature contributes its handlers through the offscreen registry.
 */
import { offscreenHandlers } from '../../features/offscreen.ts';

chrome.runtime.onMessage.addListener((msg: { target?: string; type?: string; payload?: Record<string, unknown> }, _sender, reply) => {
  if (msg?.target !== 'offscreen' || !msg.type) return;
  const handler = offscreenHandlers[msg.type];
  if (!handler) {
    reply({ ok: false, error: `unknown offscreen task ${msg.type}` });
    return;
  }
  handler(msg.payload ?? {}).then(
    (value) => reply({ ok: true, value }),
    (error: unknown) => reply({ ok: false, error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
});
