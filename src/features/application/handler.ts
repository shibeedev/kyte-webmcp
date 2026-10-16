import type { Feature } from '../../extension/background/types.ts';
import { ToolError, formatBytes, truncate } from '../../extension/background/util.ts';

/** Page function: Web Storage operations (isolated world shares the page origin's storage). */
function webStorage(area: 'local' | 'session', action: string, key?: string, value?: string, limit = 50) {
  const store = area === 'local' ? localStorage : sessionStorage;
  if (action === 'set') {
    store.setItem(key!, value ?? '');
    return { ok: true };
  }
  if (action === 'remove') {
    store.removeItem(key!);
    return { ok: true };
  }
  if (action === 'clear') {
    const n = store.length;
    store.clear();
    return { ok: true, removed: n };
  }
  if (action === 'get') return { value: store.getItem(key!) };
  const entries: Array<[string, string]> = [];
  let bytes = 0;
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i)!;
    const v = store.getItem(k) ?? '';
    bytes += (k.length + v.length) * 2;
    if (entries.length < limit) entries.push([k, v.length > 200 ? `${v.slice(0, 200)}…` : v]);
  }
  return { count: store.length, bytes, entries, origin: location.origin };
}

/** Page function: IndexedDB browsing. Every database opened here is closed again so the page is never blocked. */
async function indexedDbOp(action: string, key: string | undefined, limit: number) {
  const plain = (v: unknown, depth = 0): unknown => {
    if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? `${v}n` : v;
    if (depth > 4) return '[…]';
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Blob) return `[Blob ${v.size} bytes ${v.type}]`;
    if (v instanceof ArrayBuffer) return `[ArrayBuffer ${v.byteLength} bytes]`;
    if (ArrayBuffer.isView(v)) return `[${v.constructor.name} ${v.byteLength} bytes]`;
    if (Array.isArray(v)) return v.slice(0, 50).map((x) => plain(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v).slice(0, 50)) out[k] = plain(x, depth + 1);
    return out;
  };
  const req = <T,>(r: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const open = (name: string) =>
    new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(name);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.onupgradeneeded = () => {
        // The database did not exist: abort instead of creating it.
        r.transaction?.abort();
        reject(new Error(`database "${name}" does not exist`));
      };
      r.onblocked = () => reject(new Error(`database "${name}" is blocked by another connection`));
    });
  const [dbName, storeName, recordKey] = (key ?? '').split('/');
  if (!dbName) {
    const dbs = await indexedDB.databases();
    const out = [];
    for (const info of dbs) {
      if (!info.name) continue;
      try {
        const db = await open(info.name);
        const stores = [];
        for (const s of Array.from(db.objectStoreNames)) {
          const tx = db.transaction(s, 'readonly');
          const os = tx.objectStore(s);
          stores.push({ name: s, keyPath: os.keyPath, autoIncrement: os.autoIncrement, indexes: Array.from(os.indexNames), count: await req(os.count()) });
        }
        db.close();
        out.push({ name: info.name, version: info.version, stores });
      } catch (e) {
        out.push({ name: info.name, version: info.version, error: String(e) });
      }
    }
    return { origin: location.origin, databases: out };
  }
  const db = await open(dbName);
  try {
    if (!storeName) {
      return { database: dbName, version: db.version, stores: Array.from(db.objectStoreNames) };
    }
    if (!db.objectStoreNames.contains(storeName)) throw new Error(`store "${storeName}" not found in ${dbName}`);
    if (action === 'clear') {
      const tx = db.transaction(storeName, 'readwrite');
      await req(tx.objectStore(storeName).clear());
      return { cleared: true };
    }
    if (action === 'remove') {
      if (recordKey === undefined) throw new Error('give "db/store/key" to remove a record');
      const tx = db.transaction(storeName, 'readwrite');
      const k = /^-?\d+(\.\d+)?$/.test(recordKey) ? Number(recordKey) : recordKey;
      await req(tx.objectStore(storeName).delete(k));
      return { removed: recordKey };
    }
    const tx = db.transaction(storeName, 'readonly');
    const os = tx.objectStore(storeName);
    const count = await req(os.count());
    const records: Array<{ key: unknown; value: unknown }> = [];
    await new Promise<void>((resolve, reject) => {
      const cursorReq = os.openCursor();
      cursorReq.onsuccess = () => {
        const c = cursorReq.result;
        if (!c || records.length >= limit) return resolve();
        records.push({ key: plain(c.key), value: plain(c.value) });
        c.continue();
      };
      cursorReq.onerror = () => reject(cursorReq.error);
    });
    return { database: dbName, store: storeName, count, records };
  } finally {
    db.close();
  }
}

/** Page function: Cache Storage listing. */
async function cacheOp(name: string | undefined, limit: number) {
  const names = await caches.keys();
  if (!name) return { names };
  if (!names.includes(name)) throw new Error(`cache "${name}" not found (have: ${names.join(', ') || 'none'})`);
  const cache = await caches.open(name);
  const reqs = await cache.keys();
  return { name, count: reqs.length, urls: reqs.slice(0, limit).map((r) => `${r.method} ${r.url}`) };
}

/** Page function: service worker registrations of the page origin. */
async function serviceWorkers() {
  if (!('serviceWorker' in navigator)) return { supported: false };
  const regs = await navigator.serviceWorker.getRegistrations();
  const sw = (w: ServiceWorker | null) => (w ? { scriptURL: w.scriptURL, state: w.state } : null);
  return {
    supported: true,
    controller: navigator.serviceWorker.controller?.scriptURL ?? null,
    registrations: regs.map((r) => ({ scope: r.scope, active: sw(r.active), waiting: sw(r.waiting), installing: sw(r.installing), updateViaCache: r.updateViaCache })),
  };
}

export const applicationFeature: Feature = {
  name: 'application',
  handlers: {
    async storage(
      args: { area: string; action?: string; key?: string; value?: string; url?: string; domain?: string; path?: string; secure?: boolean; httpOnly?: boolean; sameSite?: 'no_restriction' | 'lax' | 'strict'; expires?: number; limit?: number },
      { core, tabId },
    ) {
      const action = args.action ?? 'list';
      const limit = args.limit ?? 50;
      const tab = await chrome.tabs.get(tabId);
      const pageUrl = args.url ?? tab.url ?? '';
      if (args.area === 'cookies') {
        if (action === 'list' || action === 'get') {
          const query: chrome.cookies.GetAllDetails = args.domain ? { domain: args.domain } : { url: pageUrl };
          if (args.key) query.name = args.key;
          const cookies = await chrome.cookies.getAll(query);
          if (!cookies.length) return `No cookies for ${args.domain ?? pageUrl}${args.key ? ` named ${args.key}` : ''}.`;
          return `${cookies.length} cookies for ${args.domain ?? pageUrl}:\n${cookies
            .slice(0, limit)
            .map((c) => `- ${c.name}=${action === 'get' ? c.value : c.value.length > 80 ? `${c.value.slice(0, 80)}…` : c.value} · ${c.domain}${c.path} · ${c.session ? 'session' : `expires ${new Date((c.expirationDate ?? 0) * 1000).toISOString()}`}${c.httpOnly ? ' · HttpOnly' : ''}${c.secure ? ' · Secure' : ''} · SameSite=${c.sameSite}${c.partitionKey ? ' · partitioned' : ''}`)
            .join('\n')}`;
        }
        if (action === 'set') {
          if (!args.key) throw new ToolError('key (cookie name) is required.');
          const c = await chrome.cookies.set({ url: pageUrl, name: args.key, value: args.value ?? '', domain: args.domain, path: args.path ?? '/', secure: args.secure, httpOnly: args.httpOnly, sameSite: args.sameSite, expirationDate: args.expires });
          if (!c) throw new ToolError('Chrome rejected the cookie (check domain/secure/SameSite).');
          return `Set cookie ${c.name} for ${c.domain}${c.path}.`;
        }
        if (action === 'remove') {
          if (!args.key) throw new ToolError('key (cookie name) is required.');
          await chrome.cookies.remove({ url: pageUrl, name: args.key });
          return `Removed cookie ${args.key} for ${pageUrl}.`;
        }
        const all = await chrome.cookies.getAll(args.domain ? { domain: args.domain } : { url: pageUrl });
        for (const c of all) await chrome.cookies.remove({ url: `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path}`, name: c.name, storeId: c.storeId });
        return `Removed ${all.length} cookies for ${args.domain ?? pageUrl}.`;
      }
      await core.cdp.ensure(tabId);
      if (args.area === 'local' || args.area === 'session') {
        if (['get', 'set', 'remove'].includes(action) && !args.key) throw new ToolError('key is required.');
        const res = await core.page.evaluate<any>(tabId, webStorage, [args.area, action, args.key, args.value, limit]);
        if (action === 'get') return res.value === null ? `No ${args.area}Storage item "${args.key}".` : truncate(res.value, 20_000);
        if (action !== 'list') return `${args.area}Storage ${action} done${res.removed !== undefined ? ` (${res.removed} items removed)` : ''}.`;
        return `${args.area}Storage of ${res.origin}: ${res.count} items, ~${formatBytes(res.bytes)}\n${res.entries.map(([k, v]: [string, string]) => `- ${k} = ${v}`).join('\n')}`;
      }
      if (args.area === 'indexeddb') {
        if (action === 'set') throw new ToolError('Writing IndexedDB records is not supported; use evaluate with your own code.');
        const res = await core.page.evaluate<any>(tabId, indexedDbOp, [action, args.key, limit]);
        if (res.databases) {
          if (!res.databases.length) return `No IndexedDB databases for ${res.origin}.`;
          return `IndexedDB of ${res.origin}:\n${res.databases
            .map((db: any) =>
              db.error
                ? `- ${db.name} (v${db.version}): ${db.error}`
                : `- ${db.name} (v${db.version})\n${db.stores.map((s: any) => `  - ${s.name}: ${s.count} records${s.keyPath ? ` · keyPath ${JSON.stringify(s.keyPath)}` : ''}${s.autoIncrement ? ' · autoIncrement' : ''}${s.indexes.length ? ` · indexes ${s.indexes.join(', ')}` : ''}`).join('\n')}`,
            )
            .join('\n')}\nRead records with key "<db>/<store>".`;
        }
        if (res.records) {
          return truncate(`${res.database}/${res.store}: ${res.count} records (showing ${res.records.length})\n${res.records.map((r: any) => `- key ${JSON.stringify(r.key)}: ${JSON.stringify(r.value)}`).join('\n')}`, 40_000);
        }
        if (res.stores) return `${res.database} (v${res.version}) stores: ${res.stores.join(', ')}`;
        return `IndexedDB ${action} done: ${JSON.stringify(res)}`;
      }
      if (args.area === 'cache') {
        const res = await core.page.evaluate<any>(tabId, cacheOp, [args.key, limit]);
        return res.names ? `Caches: ${res.names.join(', ') || '(none)'}` : `Cache "${res.name}" holds ${res.count} entries:\n${res.urls.join('\n')}`;
      }
      if (args.area === 'serviceworkers') {
        const res = await core.page.evaluate<any>(tabId, serviceWorkers);
        if (!res.supported) return 'Service workers are not available in this context.';
        return `Controller: ${res.controller ?? 'none'}\n${res.registrations.map((r: any) => `- scope ${r.scope} · active ${r.active?.scriptURL ?? '-'} (${r.active?.state ?? '-'})${r.waiting ? ` · waiting ${r.waiting.scriptURL}` : ''}`).join('\n') || 'No registrations.'}`;
      }
      if (args.area === 'manifest') {
        const res = await core.cdp.send(tabId, 'Page.getAppManifest');
        if (!res.url) return 'This page has no web app manifest.';
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(res.data ?? '{}');
        } catch {
          /* report raw errors below */
        }
        return [`Manifest ${res.url}`, `name: ${data.name ?? '-'} · short_name: ${data.short_name ?? '-'} · start_url: ${data.start_url ?? '-'} · display: ${data.display ?? '-'} · icons: ${(data.icons as unknown[] | undefined)?.length ?? 0}`, res.errors?.length ? `Errors: ${res.errors.map((e: any) => e.message).join('; ')}` : 'No manifest errors.', truncate(res.data ?? '', 4000)].join('\n');
      }
      if (args.area === 'quota') {
        const origin = new URL(pageUrl).origin;
        const res = await core.cdp.send(tabId, 'Storage.getUsageAndQuota', { origin });
        const parts = (res.usageBreakdown as Array<{ storageType: string; usage: number }>).filter((u) => u.usage > 0).map((u) => `${u.storageType} ${formatBytes(u.usage)}`);
        return `Storage for ${origin}: ${formatBytes(res.usage)} used of ${formatBytes(res.quota)}${res.overrideActive ? ' (quota overridden)' : ''}${parts.length ? ` — ${parts.join(', ')}` : ''}.`;
      }
      throw new ToolError(`Unknown storage area "${args.area}".`);
    },
  },
};
