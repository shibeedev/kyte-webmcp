import type { Core } from '../../extension/background/core.ts';
import type { Feature } from '../../extension/background/types.ts';
import { ToolError, truncate } from '../../extension/background/util.ts';

/** Page function: a CSS path that uniquely identifies the element (used to reveal it in DevTools). */
function cssPath(this: Element): string {
  const parts: string[] = [];
  let el: Element | null = this;
  while (el && el.nodeType === 1 && el !== document.documentElement) {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(el.id)}`);
      break;
    }
    const tag = el.tagName.toLowerCase();
    const parent: Element | null = el.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const same = Array.from(parent.children).filter((c) => c.tagName === el!.tagName);
    parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag);
    el = parent;
  }
  return parts.join(' > ') || 'html';
}

/** Resolves a selector from DevTools into a ref usable by the other tools. */
async function refForSelector(core: Core, tabId: number, selector: string): Promise<string | undefined> {
  try {
    const nodes = await core.page.elementsFrom(tabId, (sel: string) => Array.from(document.querySelectorAll(sel)).slice(0, 1), [selector]);
    if (!nodes[0]) return undefined;
    return core.refs.register({ tabId, ...nodes[0] }).ref;
  } catch {
    return undefined;
  }
}

export const devtoolsPanelFeature: Feature = {
  name: 'devtools-panel',
  handlers: {
    async devtools_context(args: { clearInbox?: boolean }, { core, tabId }) {
      const ctx = core.ui.devtoolsContext(tabId);
      const lines: string[] = [];
      if (!ctx.open) lines.push('DevTools is not open on this tab (ask the user to press F12 if you need their selection).');
      if (ctx.selection) {
        await core.cdp.ensure(tabId);
        const ref = await refForSelector(core, tabId, ctx.selection.selector);
        lines.push(
          `Selected in the Elements panel${ref ? ` → [ref=${ref}]` : ''}: <${ctx.selection.tag}${ctx.selection.id ? `#${ctx.selection.id}` : ''}${ctx.selection.classes?.length ? `.${ctx.selection.classes.join('.')}` : ''}> selector ${ctx.selection.selector}`,
          ctx.selection.text ? `  text: ${JSON.stringify(ctx.selection.text)}` : '',
          ctx.selection.html ? `  html: ${truncate(ctx.selection.html, 1500)}` : '',
        );
      } else if (ctx.open) lines.push('No element is selected in the Elements panel.');
      if (ctx.inbox.length) {
        lines.push(`Shared by the user from the Kyte WebMCP DevTools panel (${ctx.inbox.length}):`);
        for (const item of ctx.inbox) {
          const data = item.data as Record<string, any>;
          const what =
            item.kind === 'element'
              ? `element ${data.selector}${data.text ? ` "${String(data.text).slice(0, 80)}"` : ''}`
              : `request ${data.method ?? ''} ${data.status ?? ''} ${data.url ?? ''}${data.mimeType ? ` (${data.mimeType})` : ''}`;
          lines.push(`- #${item.id} [${new Date(item.at).toISOString().slice(11, 19)}] ${what}${item.note ? ` — note: "${item.note}"` : ''}`);
          if (item.kind === 'request' && data.response) lines.push(`  response excerpt: ${truncate(String(data.response), 2000)}`);
          if (item.kind === 'element' && data.html) lines.push(`  html: ${truncate(String(data.html), 1000)}`);
        }
        if (args.clearInbox) core.ui.clearInbox(tabId, ctx.inbox.map((i) => i.id));
      } else lines.push('The user has not shared anything from the Kyte WebMCP DevTools panel.');
      return lines.filter(Boolean).join('\n');
    },

    async devtools_reveal(args: { ref?: string; selector?: string; url?: string; line?: number; column?: number }, { core, tabId }) {
      if (args.url) {
        await core.ui.reveal(tabId, { url: args.url, line: args.line, column: args.column });
        return `Opened ${args.url}${args.line ? `:${args.line}` : ''} in the user's DevTools Sources panel.`;
      }
      let selector = args.selector;
      if (args.ref) {
        await core.cdp.ensure(tabId);
        const entry = core.refs.get(tabId, args.ref);
        if (entry.sessionId) throw new ToolError('Revealing elements inside out-of-process iframes is not supported; reveal the iframe element instead.');
        selector = await core.page.callOn<string>(entry, cssPath);
      }
      if (!selector) throw new ToolError('Give a ref, a selector, or a url.');
      await core.ui.reveal(tabId, { selector });
      return `Showing ${selector} in the user's DevTools Elements panel.`;
    },
  },
};
