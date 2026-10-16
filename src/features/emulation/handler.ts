import type { Core } from '../../extension/background/core.ts';
import type { Feature } from '../../extension/background/types.ts';
import { ToolError, sleep } from '../../extension/background/util.ts';

interface Device {
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  touch: boolean;
  userAgent?: string;
}

const DEVICES: Record<string, Device> = {
  'iphone-15-pro': { width: 393, height: 852, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  'pixel-8': { width: 412, height: 915, deviceScaleFactor: 2.625, mobile: true, touch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36' },
  'galaxy-s24': { width: 360, height: 780, deviceScaleFactor: 3, mobile: true, touch: true, userAgent: 'Mozilla/5.0 (Linux; Android 15; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Mobile Safari/537.36' },
  'ipad-air': { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true, touch: true, userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
  'desktop-1080p': { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false, touch: false },
  'laptop-1366': { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false, touch: false },
};

/** DevTools network presets (throughput in bytes/s, latency in ms). */
const NETWORKS: Record<string, { offline: boolean; latency: number; downloadThroughput: number; uploadThroughput: number }> = {
  none: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
  offline: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'slow-3g': { offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  'fast-3g': { offline: false, latency: 562.5, downloadThroughput: 180_000, uploadThroughput: 84_375 },
  '4g': { offline: false, latency: 165, downloadThroughput: 1_012_500, uploadThroughput: 1_012_500 },
};

interface EmulationState {
  owner: string;
  active: Record<string, string>;
  media: Array<{ name: string; value: string }>;
  geolocationOrigin?: string;
  userAgent?: string;
  acceptLanguage?: string;
  /** What the page saw before the first emulation, so a reset can confirm it is back. */
  before?: ReturnType<typeof viewportState>;
}

const states = new Map<number, EmulationState>();

async function reset(core: Core, tabId: number): Promise<void> {
  const s = (m: string, p: Record<string, unknown> = {}) => core.cdp.send(tabId, m, p).catch(() => {});
  await s('Emulation.clearDeviceMetricsOverride');
  await s('Emulation.setTouchEmulationEnabled', { enabled: false });
  await s('Emulation.setEmitTouchEventsForMouse', { enabled: false });
  await s('Emulation.setUserAgentOverride', { userAgent: '' });
  await s('Emulation.setLocaleOverride', {});
  await s('Emulation.setTimezoneOverride', { timezoneId: '' });
  await s('Emulation.clearGeolocationOverride');
  await s('Emulation.setEmulatedMedia', { media: '', features: [] });
  await s('Network.emulateNetworkConditions', NETWORKS.none!);
  await s('Emulation.setCPUThrottlingRate', { rate: 1 });
  await s('Emulation.setEmulatedVisionDeficiency', { type: 'none' });
  const st = states.get(tabId);
  if (st?.geolocationOrigin) await chrome.contentSettings.location.clear({}).catch(() => {});
  states.delete(tabId);
}

function viewportState() {
  return {
    w: innerWidth,
    h: innerHeight,
    sw: screen.width,
    sh: screen.height,
    dpr: devicePixelRatio,
    ua: navigator.userAgent,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lang: navigator.language,
    intl: Intl.DateTimeFormat().resolvedOptions().locale,
    dark: matchMedia('(prefers-color-scheme: dark)').matches,
    touch: navigator.maxTouchPoints,
  };
}

function seen(v: ReturnType<typeof viewportState>): string {
  const layout = v.w !== v.sw ? ` (layout viewport ${v.w}×${v.h}${v.w === 980 ? ', the page has no <meta name=viewport>' : ''})` : '';
  return `screen ${v.sw}×${v.sh} @${v.dpr}x${layout}, touch points ${v.touch}, language ${v.lang} (Intl ${v.intl}), timezone ${v.tz}, dark mode ${v.dark ? 'on' : 'off'}`;
}

export const emulationFeature: Feature = {
  name: 'emulation',
  setup(core) {
    core.onSessionEnd(async (session) => {
      for (const [tabId, st] of states) if (st.owner === session.id && core.cdp.isAttached(tabId)) await reset(core, tabId);
    });
    chrome.tabs.onRemoved.addListener((tabId) => states.delete(tabId));
  },
  handlers: {
    async emulate(args: Record<string, any>, { core, tabId, session, signal }) {
      await core.cdp.ensure(tabId);
      const read = () => core.page.evaluate<ReturnType<typeof viewportState>>(tabId, viewportState);
      if (args.reset) {
        const before = states.get(tabId)?.before;
        await reset(core, tabId);
        // Chrome applies some of this asynchronously (the viewport resize, media features): wait until the page sees its old state.
        let v = await read();
        for (let i = 0; before && i < 20 && JSON.stringify(v) !== JSON.stringify(before); i++) {
          await sleep(100, signal);
          v = await read();
        }
        return `All emulation removed. The page now sees ${seen(v)}.`;
      }
      const st = states.get(tabId) ?? { owner: session.id, active: {}, media: [], before: await read() };
      st.owner = session.id;
      const send = (m: string, p: Record<string, unknown>) => core.cdp.send(tabId, m, p);
      const device = args.device ? DEVICES[args.device] : undefined;
      if (args.device && !device) throw new ToolError(`Unknown device ${args.device}.`);
      if (device || args.width || args.height || args.deviceScaleFactor || args.mobile !== undefined) {
        const width = args.width ?? device?.width;
        const height = args.height ?? device?.height;
        if (!width || !height) throw new ToolError('Give both width and height (or a device).');
        const dsf = args.deviceScaleFactor ?? device?.deviceScaleFactor ?? 1;
        const mobile = args.mobile ?? device?.mobile ?? false;
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dsf, mobile, screenWidth: width, screenHeight: height });
        st.active.viewport = `${width}×${height} @${dsf}x${mobile ? ' mobile' : ''}${args.device ? ` (${args.device})` : ''}`;
      }
      const touch = args.touch ?? device?.touch;
      if (touch !== undefined) {
        await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
        await send('Emulation.setEmitTouchEventsForMouse', { enabled: touch, configuration: 'mobile' });
        st.active.touch = touch ? 'on' : 'off';
      }
      const ua = args.userAgent ?? device?.userAgent;
      if (ua) st.userAgent = ua;
      if (args.locale) st.acceptLanguage = args.locale;
      if (ua || args.locale) {
        // One call sets the UA string and the language seen by navigator.language and Accept-Language.
        const userAgent = st.userAgent ?? (await core.page.evaluate<string>(tabId, () => navigator.userAgent));
        await send('Emulation.setUserAgentOverride', { userAgent, ...(st.acceptLanguage ? { acceptLanguage: st.acceptLanguage } : {}) });
        if (ua) st.active.userAgent = ua.length > 60 ? `${ua.slice(0, 60)}…` : ua;
      }
      if (args.locale) {
        await send('Emulation.setLocaleOverride', { locale: args.locale });
        st.active.locale = args.locale;
      }
      if (args.timezone) {
        await send('Emulation.setTimezoneOverride', { timezoneId: args.timezone });
        st.active.timezone = args.timezone;
      }
      if (args.latitude !== undefined && args.longitude !== undefined) {
        await send('Emulation.setGeolocationOverride', { latitude: args.latitude, longitude: args.longitude, accuracy: 30 });
        // Grant the permission so pages get the position without a prompt; undone on reset.
        const tab = await chrome.tabs.get(tabId);
        if (tab.url?.startsWith('http')) {
          const origin = new URL(tab.url).origin;
          await chrome.contentSettings.location.set({ primaryPattern: `${origin}/*`, setting: 'allow' }).catch(() => {});
          st.geolocationOrigin = origin;
        }
        st.active.geolocation = `${args.latitude}, ${args.longitude}`;
      }
      if (args.colorScheme || args.reducedMotion !== undefined) {
        const media = st.media.filter((f) => !(args.colorScheme && f.name === 'prefers-color-scheme') && !(args.reducedMotion !== undefined && f.name === 'prefers-reduced-motion'));
        if (args.colorScheme) media.push({ name: 'prefers-color-scheme', value: args.colorScheme });
        if (args.reducedMotion !== undefined) media.push({ name: 'prefers-reduced-motion', value: args.reducedMotion ? 'reduce' : 'no-preference' });
        await send('Emulation.setEmulatedMedia', { features: media });
        st.media = media;
        st.active.media = media.map((f) => `${f.name}: ${f.value}`).join(', ');
      }
      if (args.network || args.downloadKbps || args.uploadKbps || args.latencyMs) {
        const base = { ...(NETWORKS[args.network ?? 'none'] ?? NETWORKS.none!) };
        if (args.downloadKbps) base.downloadThroughput = (args.downloadKbps * 1000) / 8;
        if (args.uploadKbps) base.uploadThroughput = (args.uploadKbps * 1000) / 8;
        if (args.latencyMs) base.latency = args.latencyMs;
        await send('Network.emulateNetworkConditions', base);
        st.active.network = args.network ?? `custom ${args.downloadKbps ?? '∞'}/${args.uploadKbps ?? '∞'} kbps, ${args.latencyMs ?? 0} ms`;
      }
      if (args.cpuSlowdown) {
        await send('Emulation.setCPUThrottlingRate', { rate: args.cpuSlowdown });
        st.active.cpu = `${args.cpuSlowdown}x slower`;
      }
      if (args.visionDeficiency) {
        await send('Emulation.setEmulatedVisionDeficiency', { type: args.visionDeficiency });
        st.active.vision = args.visionDeficiency;
      }
      states.set(tabId, st);
      const v = await core.page.evaluate<ReturnType<typeof viewportState>>(tabId, viewportState);
      return `Emulation active: ${Object.entries(st.active).map(([k, val]) => `${k} = ${val}`).join(' · ') || 'none'}.\nThe page sees ${seen(v)}. Removed with emulate(reset=true) or when the session ends.`;
    },
  },
};
