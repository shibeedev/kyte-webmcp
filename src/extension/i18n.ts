/** chrome.i18n lookup (English + Vietnamese, chosen by Chrome's UI language). */
export function t(key: string, substitutions?: string | string[]): string {
  try {
    return chrome.i18n.getMessage(key, substitutions) || key;
  } catch {
    return key;
  }
}

/** Fills every element carrying data-i18n / data-i18n-title / data-i18n-placeholder. */
export function localize(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n!);
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle!);
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder!);
  document.documentElement.lang = chrome.i18n.getUILanguage().startsWith('vi') ? 'vi' : 'en';
}
