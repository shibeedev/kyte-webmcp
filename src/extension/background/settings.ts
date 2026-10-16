export interface SettingsData {
  /** Show the glowing border + "agent is controlling" pill on controlled tabs. */
  overlay: boolean;
  /** Whisper model size used when a tool does not choose one. */
  whisperModel: 'tiny' | 'base' | 'small';
}

const DEFAULTS: SettingsData = { overlay: true, whisperModel: 'base' };

export class Settings {
  #data: SettingsData = { ...DEFAULTS };
  readonly #listeners = new Set<(s: SettingsData) => void>();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = chrome.storage.local
      .get('settings')
      .then((stored) => {
        this.#data = { ...DEFAULTS, ...((stored.settings as Partial<SettingsData>) ?? {}) };
      })
      .catch(() => {});
  }

  get(): SettingsData {
    return this.#data;
  }

  async update(patch: Partial<SettingsData>): Promise<void> {
    const next = { ...this.#data };
    if (typeof patch.overlay === 'boolean') next.overlay = patch.overlay;
    if (patch.whisperModel && ['tiny', 'base', 'small'].includes(patch.whisperModel)) next.whisperModel = patch.whisperModel;
    this.#data = next;
    await chrome.storage.local.set({ settings: next });
    for (const l of this.#listeners) l(next);
  }

  onChange(listener: (s: SettingsData) => void): void {
    this.#listeners.add(listener);
  }
}
