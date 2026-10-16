import type { Feature } from '../../extension/background/types.ts';
import { ToolError, formatBytes, sleep } from '../../extension/background/util.ts';

function describeDownload(d: chrome.downloads.DownloadItem): string {
  const progress = d.totalBytes > 0 ? ` ${Math.round((d.bytesReceived / d.totalBytes) * 100)}%` : '';
  return `#${d.id} ${d.state}${d.state === 'in_progress' ? progress : ''}${d.error ? ` (${d.error})` : ''} ${d.filename || '(pending name)'} ← ${d.finalUrl || d.url} · ${formatBytes(d.fileSize > 0 ? d.fileSize : d.bytesReceived)}`;
}

const PAPER: Record<string, [number, number]> = { A4: [8.27, 11.69], Letter: [8.5, 11], Legal: [8.5, 14], A3: [11.69, 16.54], A5: [5.83, 8.27] };

export const browserFeature: Feature = {
  name: 'browser',
  handlers: {
    async downloads(args: { action: 'download' | 'list' | 'wait' | 'cancel'; url?: string; filename?: string; id?: number; limit?: number; timeoutMs?: number }, { signal }) {
      if (args.action === 'download') {
        if (!args.url) throw new ToolError('url is required.');
        const id = await chrome.downloads.download({ url: args.url, filename: args.filename, conflictAction: 'uniquify', saveAs: false });
        await sleep(300, signal);
        const [item] = await chrome.downloads.search({ id });
        return `Started download ${item ? describeDownload(item) : `#${id}`}. Use downloads(action="wait", id=${id}) to wait for it.`;
      }
      if (args.action === 'list') {
        const items = await chrome.downloads.search({ orderBy: ['-startTime'], limit: args.limit ?? 20 });
        return items.length ? items.map(describeDownload).join('\n') : 'No downloads.';
      }
      if (args.id === undefined) throw new ToolError('id is required.');
      if (args.action === 'cancel') {
        await chrome.downloads.cancel(args.id);
        return `Cancelled download #${args.id}.`;
      }
      const deadline = Date.now() + (args.timeoutMs ?? 60_000);
      for (;;) {
        const [item] = await chrome.downloads.search({ id: args.id });
        if (!item) throw new ToolError(`No download #${args.id}.`);
        if (item.state !== 'in_progress') return `Download finished: ${describeDownload(item)}`;
        if (Date.now() > deadline) throw new ToolError(`Download #${args.id} is still running: ${describeDownload(item)}`);
        await sleep(250, signal);
      }
    },

    async history_search(args: { text?: string; startTime?: number; maxResults?: number }) {
      const items = await chrome.history.search({ text: args.text ?? '', startTime: args.startTime ?? 0, maxResults: args.maxResults ?? 50 });
      if (!items.length) return 'No matching history entries.';
      return items.map((h) => `- ${new Date(h.lastVisitTime ?? 0).toISOString().slice(0, 16).replace('T', ' ')} · ${h.visitCount} visits · ${h.title || '(no title)'} — ${h.url}`).join('\n');
    },

    async bookmarks(args: { action: 'search' | 'create' | 'remove'; query?: string; title?: string; url?: string; parentId?: string; id?: string }) {
      if (args.action === 'search') {
        const found = await chrome.bookmarks.search(args.query ?? '');
        if (!found.length) return 'No bookmarks match.';
        return found.slice(0, 100).map((b) => `- [${b.id}] ${b.title}${b.url ? ` — ${b.url}` : ' (folder)'}`).join('\n');
      }
      if (args.action === 'create') {
        if (!args.url && !args.title) throw new ToolError('Give a url (and title) to create a bookmark, or a title for a folder.');
        const b = await chrome.bookmarks.create({ parentId: args.parentId, title: args.title ?? args.url, url: args.url });
        return `Created bookmark [${b.id}] ${b.title}${b.url ? ` — ${b.url}` : ' (folder)'}.`;
      }
      if (!args.id) throw new ToolError('id is required.');
      await chrome.bookmarks.remove(args.id);
      return `Removed bookmark ${args.id}.`;
    },

    async clipboard(args: { action: 'read' | 'write'; text?: string }, { core }) {
      if (args.action === 'write') {
        await core.offscreen.call('clipboard.write', { text: args.text ?? '' });
        return `Copied ${(args.text ?? '').length} characters to the clipboard.`;
      }
      const text = await core.offscreen.call<string>('clipboard.read');
      return text ? `Clipboard (${text.length} characters):\n${text.slice(0, 20_000)}` : 'The clipboard is empty or holds no text.';
    },

    async pdf_save(args: { savePath?: string; landscape?: boolean; printBackground?: boolean; scale?: number; paper?: string }, { core, tabId, session }) {
      await core.cdp.ensure(tabId);
      const [w, h] = PAPER[args.paper ?? 'A4'] ?? PAPER.A4!;
      const res = await core.cdp.send(tabId, 'Page.printToPDF', { landscape: !!args.landscape, printBackground: args.printBackground ?? true, scale: args.scale ?? 1, paperWidth: w, paperHeight: h, transferMode: 'ReturnAsStream' });
      const handle: string = res.stream;
      const tab = await chrome.tabs.get(tabId);
      const saved = await session.streamFile({ path: args.savePath, stem: (tab.title || 'page').slice(0, 40), ext: 'pdf' }, async (write) => {
        for (;;) {
          const chunk = await core.cdp.send(tabId, 'IO.read', { handle, size: 1_048_576 });
          if (chunk.data) await write(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8');
          if (chunk.eof) break;
        }
      });
      await core.cdp.send(tabId, 'IO.close', { handle }).catch(() => {});
      return `Saved "${tab.title}" as PDF to ${saved.path} (${formatBytes(saved.bytes)}).`;
    },
  },
};
