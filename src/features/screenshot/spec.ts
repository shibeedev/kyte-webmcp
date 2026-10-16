import { bool, defineTools, int, obj, oneOf, refParam, savePathParam, tabIdParam } from '../../shared/tool-spec.ts';

export const screenshotTools = defineTools({
  name: 'screenshot',
  title: 'Screenshot',
  description:
    'Captures the viewport, the full page, or one element. With annotate=true, draws numbered boxes labelled with element refs over interactive elements (Set-of-Mark) so you can point at things visually. Images are downscaled to maxWidth to save tokens; savePath writes a file instead of returning the image. Works on background tabs.',
  inputSchema: obj({
    fullPage: bool('Capture the whole scrollable page (default false).'),
    ref: refParam,
    annotate: bool('Draw ref labels over interactive elements (default false).'),
    format: oneOf(['jpeg', 'png', 'webp'], 'Image format (default jpeg).'),
    quality: int('JPEG/WebP quality 1-100 (default 80).', { minimum: 1, maximum: 100 }),
    maxWidth: int('Downscale so the image is at most this wide (default 1280).', { minimum: 100, maximum: 4096 }),
    savePath: savePathParam,
    tabId: tabIdParam,
  }),
  annotations: { readOnlyHint: true, openWorldHint: false },
  timeoutMs: 30_000,
});
