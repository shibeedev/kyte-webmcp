/**
 * Functions injected into pages (CDP isolated world). They must stay
 * self-contained: no imports, no references to outer variables.
 */

export function pageMarkdown(this: unknown, opts: { selector?: string; mainOnly?: boolean; includeImages?: boolean }): string {
  const self = this as Element | undefined;
  const start: Element =
    (self && (self as Element).nodeType === 1 ? self : null) ??
    (opts.selector ? document.querySelector(opts.selector) : null) ??
    (opts.mainOnly !== false ? document.querySelector('main, [role="main"], article') : null) ??
    document.body ??
    document.documentElement;
  const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'DETAILS', 'DIALOG', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'HEADER', 'MAIN', 'NAV', 'SECTION', 'SUMMARY', 'CENTER']);
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'SVG', 'CANVAS', 'OBJECT', 'EMBED', 'MAP']);
  let budget = 400_000;
  const clean = (s: string) => s.replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n */g, '\n').trim();
  const hidden = (el: Element) => {
    if ((el as HTMLElement).hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const s = getComputedStyle(el);
    return s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse';
  };
  const kids = (el: Element): Node[] => {
    if (el.tagName === 'SLOT') {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      return assigned.length ? assigned : Array.from(el.childNodes);
    }
    const root = (el as HTMLElement).shadowRoot;
    return root ? Array.from(root.childNodes) : Array.from(el.childNodes);
  };
  const render = (node: Node, depth: number, pre: boolean): string => {
    if (budget <= 0) return '';
    if (node.nodeType === Node.TEXT_NODE) {
      const t = pre ? node.nodeValue ?? '' : (node.nodeValue ?? '').replace(/\s+/g, ' ');
      budget -= t.length;
      return t;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag) || hidden(el)) return '';
    const inner = (d = depth, p = pre) => kids(el).map((n) => render(n, d, p)).join('');
    switch (tag) {
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        const t = clean(inner());
        return t ? `\n\n${'#'.repeat(Number(tag[1]))} ${t.replace(/\n+/g, ' ')}\n\n` : '';
      }
      case 'P':
        return `\n\n${clean(inner())}\n\n`;
      case 'BR':
        return '\n';
      case 'HR':
        return '\n\n---\n\n';
      case 'A': {
        const t = clean(inner()).replace(/\n+/g, ' ');
        const href = el.getAttribute('href');
        if (!t || !href || href.startsWith('javascript:') || href === '#') return t;
        let abs = href;
        try {
          abs = new URL(href, location.href).href;
        } catch {
          /* keep raw */
        }
        return `[${t.replace(/[[\]]/g, '')}](${abs})`;
      }
      case 'IMG': {
        const img = el as HTMLImageElement;
        if (opts.includeImages) return `![${img.alt || ''}](${img.currentSrc || img.src})`;
        return img.alt ? ` [image: ${img.alt}] ` : '';
      }
      case 'STRONG': case 'B': {
        const t = clean(inner());
        return t ? `**${t}**` : '';
      }
      case 'EM': case 'I': {
        const t = clean(inner());
        return t ? `_${t}_` : '';
      }
      case 'CODE':
        return pre ? el.textContent ?? '' : el.textContent ? `\`${el.textContent}\`` : '';
      case 'PRE':
        return `\n\n\`\`\`\n${(el.textContent ?? '').replace(/\n$/, '')}\n\`\`\`\n\n`;
      case 'BLOCKQUOTE':
        return `\n\n${clean(inner()).split('\n').map((l) => `> ${l}`).join('\n')}\n\n`;
      case 'UL': case 'OL': {
        let i = 0;
        const items = kids(el).filter((n): n is HTMLElement => n.nodeType === 1 && (n as Element).tagName === 'LI' && !hidden(n as Element));
        const lines = items.map((li) => {
          i++;
          const marker = tag === 'OL' ? `${i}.` : '-';
          const body = clean(kids(li).map((n) => render(n, depth + 1, pre)).join('')).replace(/\n{2,}/g, '\n');
          return `${'  '.repeat(depth)}${marker} ${body.replace(/\n/g, `\n${'  '.repeat(depth + 1)}`)}`;
        });
        return `\n\n${lines.join('\n')}\n\n`;
      }
      case 'TABLE': {
        const rows = Array.from((el as HTMLTableElement).rows).filter((r) => !hidden(r));
        if (!rows.length) return '';
        const cells = rows.map((r) => Array.from(r.cells).map((c) => clean(kids(c).map((n) => render(n, depth, false)).join('')).replace(/\n+/g, ' ').replace(/\|/g, '\\|')));
        const width = Math.max(...cells.map((r) => r.length));
        const pad = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
        return `\n\n${[pad(cells[0]!), `|${' --- |'.repeat(width)}`, ...cells.slice(1).map(pad)].join('\n')}\n\n`;
      }
      case 'INPUT': {
        const input = el as HTMLInputElement;
        if (input.type === 'hidden') return '';
        if (input.type === 'checkbox' || input.type === 'radio') return input.checked ? '[x] ' : '[ ] ';
        if (input.type === 'submit' || input.type === 'button' || input.type === 'reset') return ` [${input.value}] `;
        return ` [input${input.value ? `: ${input.value}` : input.placeholder ? ` (${input.placeholder})` : ''}] `;
      }
      case 'TEXTAREA':
        return ` [textarea${(el as HTMLTextAreaElement).value ? `: ${(el as HTMLTextAreaElement).value.slice(0, 200)}` : ''}] `;
      case 'SELECT':
        return ` [select: ${(el as HTMLSelectElement).selectedOptions[0]?.text ?? ''}] `;
      case 'BUTTON': {
        const t = clean(inner());
        return t ? ` [${t}] ` : '';
      }
      case 'IFRAME':
        return `\n\n[iframe: ${(el as HTMLIFrameElement).src}]\n\n`;
      case 'VIDEO': case 'AUDIO':
        return `\n\n[${tag.toLowerCase()}: ${(el as HTMLMediaElement).currentSrc || (el as HTMLMediaElement).src}]\n\n`;
      case 'LI':
        return `\n- ${clean(inner())}\n`;
      default: {
        const s = inner();
        return BLOCK.has(tag) ? `\n\n${s}\n\n` : s;
      }
    }
  };
  const md = render(start, 0, false)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return md;
}

export function findTextElements(query: string, limit: number): Element[] {
  const needle = query.toLowerCase();
  const out: Element[] = [];
  const seen = new Set<Element>();
  const take = (el: Element) => {
    if (seen.has(el) || out.length >= limit) return;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    seen.add(el);
    out.push(el);
  };
  const visit = (root: Node) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && out.length < limit; n = walker.nextNode()) {
      if (n.nodeValue && n.nodeValue.toLowerCase().includes(needle) && n.parentElement) take(n.parentElement);
    }
    const hosts = (root as ParentNode).querySelectorAll ? (root as ParentNode).querySelectorAll('*') : [];
    for (const e of Array.from(hosts)) if ((e as HTMLElement).shadowRoot && out.length < limit) visit((e as HTMLElement).shadowRoot!);
  };
  visit(document.documentElement);
  for (const e of Array.from(document.querySelectorAll('input, textarea, button, [aria-label], [title], img[alt]'))) {
    const v = ((e as HTMLInputElement).value || (e as HTMLInputElement).placeholder || e.getAttribute('aria-label') || e.getAttribute('title') || (e as HTMLImageElement).alt || '').toLowerCase();
    if (v.includes(needle)) take(e);
  }
  return out;
}

export function querySelectorDeep(selector: string, limit: number): Element[] {
  const out: Element[] = [];
  const visit = (root: ParentNode) => {
    for (const e of Array.from(root.querySelectorAll(selector))) {
      if (out.length >= limit) return;
      out.push(e);
    }
    for (const e of Array.from(root.querySelectorAll('*'))) if ((e as HTMLElement).shadowRoot && out.length < limit) visit((e as HTMLElement).shadowRoot!);
  };
  visit(document);
  return out;
}

export function xpathElements(expression: string, limit: number): Element[] {
  const result = document.evaluate(expression, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
  const out: Element[] = [];
  for (let i = 0; i < result.snapshotLength && out.length < limit; i++) {
    const n = result.snapshotItem(i);
    const el = n && n.nodeType === 1 ? (n as Element) : n?.parentElement;
    if (el && !out.includes(el)) out.push(el);
  }
  return out;
}
