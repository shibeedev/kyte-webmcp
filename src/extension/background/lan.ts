import { NATIVE_HOST } from '../../shared/constants.ts';
import type { ExtToLanHost, LanHostToExt } from '../../shared/protocol.ts';
import type { Core } from './core.ts';

export interface LanView {
  state: 'off' | 'starting' | 'on' | 'error';
  port: number;
  /** Private IPv4 addresses of this machine, best first. */
  addresses: string[];
  token: string;
  error: string;
  /** The native host is not registered yet: the side panel shows the install command. */
  notInstalled: boolean;
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * "Allow connections from the LAN". While on, the extension keeps a native messaging
 * port to the LAN host, which serves MCP over HTTP to the LAN and gives every
 * LAN client a bridge on the loopback port range. Closing the port stops the
 * host, so turning the switch off really closes the LAN endpoint. The open
 * port also keeps the service worker alive.
 */
export class Lan {
  readonly #core: Core;
  #port: chrome.runtime.Port | null = null;
  #view: LanView = { state: 'off', port: 0, addresses: [], token: '', error: '', notInstalled: false };

  constructor(core: Core) {
    this.#core = core;
  }

  view(): LanView {
    return this.#view;
  }

  /** Starts or stops the host to match the setting; also retries a host that failed (the wake-up alarm calls it). */
  async sync(): Promise<void> {
    if (!this.#core.settings.get().lan) return this.#stop();
    if (this.#port) return;
    const token = await this.#token();
    if (this.#port || !this.#core.settings.get().lan) return;
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    this.#port = port;
    // A retry after an error keeps showing that error until the host answers.
    this.#set(this.#view.state === 'error' ? { token } : { state: 'starting', token, error: '', notInstalled: false });
    port.onMessage.addListener((msg: LanHostToExt) => {
      if (msg.t === 'listening') this.#set({ state: 'on', port: msg.port, addresses: msg.addresses, error: '', notInstalled: false });
      else if (msg.t === 'error') this.#set({ state: 'error', error: msg.message, notInstalled: false });
      else if (msg.t === 'scan') this.#core.connections.scan(true);
    });
    port.onDisconnect.addListener(() => {
      const error = chrome.runtime.lastError?.message || 'The LAN host stopped.';
      if (this.#port !== port) return;
      this.#port = null;
      this.#core.connections.closeRemote();
      this.#set({ state: 'error', port: 0, addresses: [], error, notInstalled: /not found/i.test(error) });
    });
    port.postMessage({ t: 'start', token } satisfies ExtToLanHost);
  }

  /** A new token disconnects every LAN client that used the old one. */
  async newToken(): Promise<void> {
    const token = randomToken();
    await chrome.storage.local.set({ lanToken: token });
    this.#set({ token });
    this.#port?.postMessage({ t: 'start', token } satisfies ExtToLanHost);
  }

  async #token(): Promise<string> {
    const stored = (await chrome.storage.local.get('lanToken')).lanToken;
    if (typeof stored === 'string' && stored) return stored;
    const token = randomToken();
    await chrome.storage.local.set({ lanToken: token });
    return token;
  }

  #stop(): void {
    const port = this.#port;
    this.#port = null;
    port?.disconnect();
    // The host closing its bridges would end the LAN sessions a moment later anyway; end them now.
    this.#core.connections.closeRemote();
    if (this.#view.state !== 'off') this.#set({ state: 'off', port: 0, addresses: [], error: '', notInstalled: false });
  }

  #set(patch: Partial<LanView>): void {
    this.#view = { ...this.#view, ...patch };
    this.#core.ui.refresh();
  }
}
