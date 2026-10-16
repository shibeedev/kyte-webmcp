import { bool, defineTools, int, num, obj, oneOf, str, tabIdParam } from '../../shared/tool-spec.ts';

export const applicationTools = defineTools({
  name: 'storage',
  title: 'Storage & application data',
  description:
    'Reads and edits application data like the DevTools Application panel. area: cookies (all cookies incl. HttpOnly for the page or a URL/domain), local/session (Web Storage), indexeddb (databases, stores, records), cache (Cache Storage), serviceworkers, manifest, quota. Actions: list/get read, set/remove/clear write.',
  inputSchema: obj(
    {
      area: oneOf(['cookies', 'local', 'session', 'indexeddb', 'cache', 'serviceworkers', 'manifest', 'quota'], 'Which storage.'),
      action: oneOf(['list', 'get', 'set', 'remove', 'clear'], 'What to do (default list).'),
      key: str('Cookie name, storage key, IndexedDB "db/store", or cache name.'),
      value: str('Value to set.'),
      url: str('URL whose cookies/storage to use (default: the page URL).'),
      domain: str('Cookie domain filter or domain for a new cookie.'),
      path: str('Cookie path (default "/").'),
      secure: bool('Cookie Secure flag.'),
      httpOnly: bool('Cookie HttpOnly flag.'),
      sameSite: oneOf(['no_restriction', 'lax', 'strict'], 'Cookie SameSite.'),
      expires: num('Cookie expiry (seconds since epoch); omit for a session cookie.'),
      limit: int('Maximum entries/records to return (default 50).'),
      tabId: tabIdParam,
    },
    ['area'],
  ),
  annotations: { readOnlyHint: false, openWorldHint: false },
});
