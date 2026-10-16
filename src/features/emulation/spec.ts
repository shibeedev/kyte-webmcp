import { bool, defineTools, int, num, obj, oneOf, str, tabIdParam } from '../../shared/tool-spec.ts';

export const DEVICE_PRESETS = ['iphone-15-pro', 'pixel-8', 'galaxy-s24', 'ipad-air', 'desktop-1080p', 'laptop-1366'] as const;

export const emulationTools = defineTools({
  name: 'emulate',
  title: 'Emulate device & conditions',
  description:
    'Emulates a device (preset or custom viewport), user agent, locale, timezone, geolocation, dark/light mode, reduced motion, network conditions, CPU slowdown or a vision deficiency. Settings accumulate across calls; reset=true restores everything. All emulation is removed when the session ends.',
  inputSchema: obj({
    device: oneOf([...DEVICE_PRESETS], 'Device preset.'),
    width: int('Viewport width in CSS pixels.'),
    height: int('Viewport height in CSS pixels.'),
    deviceScaleFactor: num('Device pixel ratio.'),
    mobile: bool('Mobile viewport (meta viewport, overlay scrollbars).'),
    touch: bool('Emulate a touch screen.'),
    userAgent: str('User agent string.'),
    locale: str('Locale, e.g. "vi-VN".'),
    timezone: str('IANA timezone, e.g. "Asia/Ho_Chi_Minh".'),
    latitude: num('Geolocation latitude.'),
    longitude: num('Geolocation longitude.'),
    colorScheme: oneOf(['light', 'dark'], 'prefers-color-scheme.'),
    reducedMotion: bool('prefers-reduced-motion: reduce.'),
    network: oneOf(['none', 'offline', 'slow-3g', 'fast-3g', '4g'], 'Network conditions preset ("none" removes throttling).'),
    downloadKbps: num('Custom download throughput (kbit/s).'),
    uploadKbps: num('Custom upload throughput (kbit/s).'),
    latencyMs: num('Custom extra latency (ms).'),
    cpuSlowdown: num('CPU throttling rate, e.g. 4 = 4x slower (1 removes it).', { minimum: 1, maximum: 20 }),
    visionDeficiency: oneOf(['none', 'blurredVision', 'reducedContrast', 'achromatopsia', 'deuteranopia', 'protanopia', 'tritanopia'], 'Simulated vision deficiency.'),
    reset: bool('Remove all emulation from the tab.'),
    tabId: tabIdParam,
  }),
  annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
});
