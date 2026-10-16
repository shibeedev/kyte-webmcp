import { ToolError } from './util.ts';

const IDLE_CLOSE_MS = 60_000;

/** On-demand offscreen document for DOM-only work: audio decoding, clipboard, tab audio capture. */
export class Offscreen {
  #creating: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #busy = 0;

  async #ensure(): Promise<void> {
    if (await chrome.offscreen.hasDocument()) return;
    this.#creating ??= chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.USER_MEDIA, chrome.offscreen.Reason.CLIPBOARD, chrome.offscreen.Reason.BLOBS],
        justification: 'Decode and capture media audio for local transcription, and access the clipboard for the agent.',
      })
      .finally(() => (this.#creating = null));
    await this.#creating;
  }

  async call<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    this.#busy++;
    clearTimeout(this.#timer);
    try {
      await this.#ensure();
      const res = (await chrome.runtime.sendMessage({ target: 'offscreen', type, payload })) as { ok: boolean; value?: T; error?: string } | undefined;
      if (!res) throw new ToolError('The offscreen document did not answer.');
      if (!res.ok) throw new ToolError(res.error ?? 'offscreen task failed');
      return res.value as T;
    } finally {
      this.#busy--;
      if (!this.#busy) this.#timer = setTimeout(() => void chrome.offscreen.closeDocument().catch(() => {}), IDLE_CLOSE_MS);
    }
  }
}
