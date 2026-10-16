/** Offscreen-document halves of the features. */
import { browserOffscreenHandlers } from './browser/offscreen.ts';
import { videoOffscreenHandlers } from './video/offscreen.ts';

export const offscreenHandlers: Record<string, (payload: Record<string, unknown>) => Promise<unknown>> = {
  ...browserOffscreenHandlers,
  ...videoOffscreenHandlers,
};
