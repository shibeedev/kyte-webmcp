export interface SettingsData {
  /** Master switch: when off, this profile accepts no MCP client at all (local or LAN). */
  enabled: boolean;
  /** Show the glowing border + "agent is controlling" pill on controlled tabs. */
  overlay: boolean;
  /** Whisper model size used when a tool does not choose one. */
  whisperModel: 'tiny' | 'base' | 'small';
  /** Let MCP clients on other machines of the LAN connect (off by default). */
  lan: boolean;
  /**
   * This Chrome profile's identity. Every profile runs its own copy of the extension, so bridges use it to
   * serve one profile only: `profileId` is random and never changes, `profileName` is what `--profile` matches.
   */
  profileId: string;
  profileName: string;
}

const DEFAULTS: SettingsData = { enabled: true, overlay: true, whisperModel: 'base', lan: false, profileId: '', profileName: '' };

const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

export class Settings {
  #data: SettingsData = { ...DEFAULTS };
  readonly #listeners = new Set<(s: SettingsData) => void>();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = chrome.storage.local
      .get('settings')
      .then(async (stored) => {
        this.#data = { ...DEFAULTS, ...((stored.settings as Partial<SettingsData>) ?? {}) };
        if (!this.#data.profileId) {
          // First run in this profile: a stable id and a name the user can change (Chrome offers no API for the profile's own name).
          this.#data.profileId = randomHex(16);
          this.#data.profileName ||= `Profile ${randomHex(2).toUpperCase()}`;
          await chrome.storage.local.set({ settings: this.#data });
        }
      })
      .catch(() => {});
  }

  get(): SettingsData {
    return this.#data;
  }

  async update(patch: Partial<SettingsData>): Promise<void> {
    await this.ready; // a patch applied before the stored settings load would be overwritten by them
    const next = { ...this.#data };
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    if (typeof patch.overlay === 'boolean') next.overlay = patch.overlay;
    if (patch.whisperModel && ['tiny', 'base', 'small'].includes(patch.whisperModel)) next.whisperModel = patch.whisperModel;
    if (typeof patch.lan === 'boolean') next.lan = patch.lan;
    // Quotes and control characters would break the `--profile "<name>"` command the side panel shows.
    const name = typeof patch.profileName === 'string' ? patch.profileName.replace(/["\\\u0000-\u001f]/g, '').trim().slice(0, 40) : '';
    if (name) next.profileName = name;
    this.#data = next;
    await chrome.storage.local.set({ settings: next });
    for (const l of this.#listeners) l(next);
  }

  onChange(listener: (s: SettingsData) => void): void {
    this.#listeners.add(listener);
  }
}
