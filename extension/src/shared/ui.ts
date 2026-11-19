// Bits the pages share.

export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

/** Chrome's own icon for a page (the `favicon` permission). */
export function favicon(url: string, size = 32): string {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", url);
  u.searchParams.set("size", String(size));
  return u.toString();
}

/** A folder typed as `A / B`: its names. */
export function parseFolder(text: string): string[] {
  return text.split("/").map((s) => s.trim()).filter(Boolean);
}

export function showFolder(path: string[]): string {
  return path.join(" / ");
}
