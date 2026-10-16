import type { Core } from '../../extension/background/core.ts';
import { collectFrames, isInteractive } from '../../extension/background/ax.ts';
import { nodeBox } from '../../extension/background/geometry.ts';
import { annotateImage, scaleImage, type ImageFormat, type LabelBox } from '../../extension/background/image.ts';
import type { Feature } from '../../extension/background/types.ts';
import { ToolError, imageContent } from '../../extension/background/util.ts';

/** Interactive elements inside the viewport with their refs and viewport boxes (CSS px). */
async function interactiveBoxes(core: Core, tabId: number, viewport: { width: number; height: number }): Promise<Array<{ ref: string; x: number; y: number; width: number; height: number }>> {
  const frames = await collectFrames(core, tabId);
  const out: Array<{ ref: string; x: number; y: number; width: number; height: number }> = [];
  for (const frame of frames) {
    for (const node of frame.nodes.values()) {
      if (node.ignored || node.backendDOMNodeId === undefined || !isInteractive(node)) continue;
      const entry = core.refs.register({ tabId, sessionId: frame.sessionId, frameId: node.frameId ?? frame.frameId, backendNodeId: node.backendDOMNodeId }, { role: String(node.role?.value ?? ''), name: String(node.name?.value ?? '') });
      const box = await nodeBox(core.cdp, entry).catch(() => null);
      if (!box || box.width < 2 || box.height < 2) continue;
      if (box.x + box.width < 0 || box.y + box.height < 0 || box.x > viewport.width || box.y > viewport.height) continue;
      out.push({ ref: entry.ref, ...box });
      if (out.length >= 300) return out;
    }
  }
  return out;
}

export const screenshotFeature: Feature = {
  name: 'screenshot',
  handlers: {
    async screenshot(args: { fullPage?: boolean; ref?: string; annotate?: boolean; format?: ImageFormat; quality?: number; maxWidth?: number; savePath?: string }, { core, tabId, session }) {
      await core.cdp.ensure(tabId);
      const format: ImageFormat = args.format ?? (args.savePath?.toLowerCase().endsWith('.png') ? 'png' : 'jpeg');
      const quality = args.quality ?? 80;
      const maxWidth = args.maxWidth ?? 1280;
      const metrics = await core.cdp.send(tabId, 'Page.getLayoutMetrics');
      const vv = metrics.cssVisualViewport as { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
      let params: Record<string, unknown> = { format: 'png', fromSurface: true };
      let what = 'viewport';
      if (args.ref) {
        const entry = core.refs.get(tabId, args.ref);
        await core.cdp.send(tabId, 'DOM.scrollIntoViewIfNeeded', { backendNodeId: entry.backendNodeId }, entry.sessionId).catch(() => {});
        const box = await nodeBox(core.cdp, entry);
        if (!box) throw new ToolError(`[${entry.ref}] is not rendered, so it cannot be captured.`);
        const m2 = await core.cdp.send(tabId, 'Page.getLayoutMetrics');
        params = { ...params, clip: { x: box.x + m2.cssVisualViewport.pageX, y: box.y + m2.cssVisualViewport.pageY, width: box.width, height: box.height, scale: 1 }, captureBeyondViewport: true };
        what = `${entry.role ?? 'element'}${entry.name ? ` "${entry.name.slice(0, 60)}"` : ''} [${entry.ref}]`;
      } else if (args.fullPage) {
        const size = metrics.cssContentSize as { width: number; height: number };
        const height = Math.min(size.height, 16_384);
        params = { ...params, clip: { x: 0, y: 0, width: size.width, height, scale: 1 }, captureBeyondViewport: true };
        what = `full page ${Math.round(size.width)}×${Math.round(height)}${height < size.height ? ` (cut from ${Math.round(size.height)})` : ''}`;
      }
      const shot = await core.overlay.withHidden(tabId, () => core.cdp.send(tabId, 'Page.captureScreenshot', params));
      let image;
      let annotated = 0;
      if (args.annotate) {
        if (args.ref || args.fullPage) throw new ToolError('annotate works on viewport screenshots only.');
        const boxes = await interactiveBoxes(core, tabId, { width: vv.clientWidth, height: vv.clientHeight });
        // Source pixels per CSS pixel (device scale / zoom).
        const bitmapScale = await (async () => {
          const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0))], { type: 'image/png' }));
          const s = bmp.width / vv.clientWidth;
          bmp.close();
          return s;
        })();
        const labels: LabelBox[] = boxes.map((b) => ({ x: b.x * bitmapScale, y: b.y * bitmapScale, width: b.width * bitmapScale, height: b.height * bitmapScale, label: b.ref }));
        annotated = labels.length;
        image = await annotateImage(shot.data, 'image/png', labels, maxWidth, format, quality);
      } else {
        image = await scaleImage(shot.data, 'image/png', maxWidth, format, quality);
      }
      const desc = `Screenshot of the ${what}: ${image.width}×${image.height} ${format}${annotated ? `, ${annotated} interactive elements labelled with their refs` : ''}.`;
      if (args.savePath) {
        const saved = await session.writeFile({ path: args.savePath, stem: 'screenshot', ext: format === 'jpeg' ? 'jpg' : format, data: image.data, encoding: 'base64' });
        return `${desc}\nSaved to ${saved.path} (${saved.bytes} bytes).`;
      }
      return [{ type: 'text', text: desc }, imageContent(image.data, image.mimeType)];
    },
  },
};
