// CleanTabs' service worker: the only part that talks to S3 (through the
// core, which is CleanNotes' own code for its S3 folder) and holds the
// account. The popup and the CleanTabs page ask it for everything.
//
// - Saving: tabs become tab notes in the CleanNotes account's folder, under
//   `Tabs/<folder>`; a tab group's tabs in `Tabs/<folder>/<group title>`.
// - Opening: a folder's tabs come back in a window, its sub-folders as tab
//   groups.
// - Pictures of pages (if turned on): when a tab has loaded or is shown,
//   its visible part is captured, shrunk to 384×240 or less, and kept in
//   memory (and chrome.storage.session) until the tab is saved or closed.

import init, * as core from "../core/core.js";
import type { Account, Listing, Reply, Request, Scope, Status, Tab } from "../shared/types";

let ready: Promise<unknown> | undefined;
function loadCore(): Promise<unknown> {
  ready ??= init({ module_or_path: chrome.runtime.getURL("core.wasm") });
  return ready;
}

// ---- S3 -------------------------------------------------------------------

interface CoreRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body: Uint8Array;
}

const S3_TIMEOUT_MS = 30_000;

/** The core's transport: fetch, without following redirects or cookies. */
async function s3fetch(req: CoreRequest) {
  const resp = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    redirect: "manual",
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(S3_TIMEOUT_MS),
  });
  const headers: [string, string][] = [];
  resp.headers.forEach((v, k) => headers.push([k, v]));
  // A redirect (wrong region) comes back opaque, as status 0.
  const status = resp.type === "opaqueredirect" ? 301 : resp.status;
  return { status, headers, body: new Uint8Array(await resp.arrayBuffer()) };
}

async function account(): Promise<Account> {
  const { account } = await chrome.storage.local.get("account");
  if (!account) throw new Error("Set up CleanTabs first: it needs your CleanNotes S3 account.");
  return account as Account;
}

// ---- The saved tabs, as last read -------------------------------------------

let listing: Listing | null = null;

async function cached(): Promise<Listing | null> {
  if (!listing) listing = ((await chrome.storage.local.get("listing")).listing as Listing | undefined) ?? null;
  return listing;
}

async function store(l: Listing): Promise<Listing> {
  listing = l;
  await chrome.storage.local.set({ listing: l });
  return l;
}

async function refresh(): Promise<Listing> {
  await loadCore();
  return store((await core.list(await account(), s3fetch)) as Listing);
}

/** The listing with `changed` tabs put in (by stem). */
async function merge(changed: Tab[]): Promise<Listing> {
  const l = (await cached()) ?? { tabs: [], folders: [["Tabs"]] };
  const byStem = new Map(l.tabs.map((t) => [t.stem, t]));
  for (const t of changed) byStem.set(t.stem, t);
  const tabs = [...byStem.values()].sort((a, b) => a.created.localeCompare(b.created));
  const folders = new Map(l.folders.map((f) => [JSON.stringify(f), f]));
  for (const t of changed) {
    if (t.deleted || t.folder[0] !== "Tabs") continue;
    for (let n = 1; n <= t.folder.length; n++) folders.set(JSON.stringify(t.folder.slice(0, n)), t.folder.slice(0, n));
  }
  const sorted = [...folders.values()].sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")));
  return store({ tabs, folders: sorted });
}

// ---- Pictures of pages ------------------------------------------------------

const THUMB_W = 384;
const THUMB_H = 240;
/** Chrome allows two captures a second. */
const CAPTURE_GAP_MS = 600;
const MAX_THUMBS = 300;

interface Thumb {
  url: string;
  /** JPEG, base64. */
  data: string;
}

const thumbs = new Map<number, Thumb>();
let thumbsLoaded: Promise<void> | undefined;
function loadThumbs(): Promise<void> {
  thumbsLoaded ??= chrome.storage.session.get("thumbs").then(({ thumbs: saved }) => {
    for (const [id, t] of Object.entries((saved ?? {}) as Record<string, Thumb>)) thumbs.set(Number(id), t);
  });
  return thumbsLoaded;
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistThumbs(): void {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    while (thumbs.size > MAX_THUMBS) thumbs.delete(thumbs.keys().next().value!);
    void chrome.storage.session.set({ thumbs: Object.fromEntries(thumbs) }).catch(() => {});
  }, 1000);
}

async function picturesOn(): Promise<boolean> {
  const { pictures } = await chrome.storage.local.get("pictures");
  return pictures === true && (await chrome.permissions.contains({ origins: ["<all_urls>"] }));
}

function base64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The top of a screenshot, at most THUMB_W × THUMB_H, as JPEG (base64). */
async function shrink(dataUrl: string): Promise<string> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const scale = Math.min(1, THUMB_W / bitmap.width);
  const w = Math.round(bitmap.width * scale);
  const srcH = Math.min(bitmap.height, THUMB_H / scale);
  const h = Math.round(srcH * scale);
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, bitmap.width, srcH, 0, 0, w, h);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 });
  return base64(new Uint8Array(await blob.arrayBuffer()));
}

const captureTimers = new Map<number, ReturnType<typeof setTimeout>>();
let lastCapture = 0;
let captureQueue: Promise<void> = Promise.resolve();

/** Captures window `windowId`'s tab `tabId` soon, if it's still shown then. */
function scheduleCapture(tabId: number, windowId: number): void {
  clearTimeout(captureTimers.get(windowId));
  captureTimers.set(
    windowId,
    setTimeout(() => {
      captureQueue = captureQueue.then(() => capture(tabId, windowId)).catch(() => {});
    }, 700),
  );
}

async function capture(tabId: number, windowId: number): Promise<void> {
  if (!(await picturesOn())) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.active || tab.status !== "complete" || !tab.url || !/^https?:/.test(tab.url)) return;
  const wait = lastCapture + CAPTURE_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCapture = Date.now();
  const shot = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 80 });
  // Another tab may have been shown meanwhile.
  const now = await chrome.tabs.get(tabId).catch(() => null);
  if (!now?.active || now.url !== tab.url) return;
  await loadThumbs();
  thumbs.delete(tabId);
  thumbs.set(tabId, { url: tab.url, data: await shrink(shot) });
  persistThumbs();
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => scheduleCapture(tabId, windowId));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "complete" && tab.active) scheduleCapture(tabId, tab.windowId);
});
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [tab] = await chrome.tabs.query({ active: true, windowId });
  if (tab?.id !== undefined) scheduleCapture(tab.id, windowId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void loadThumbs().then(() => {
    if (thumbs.delete(tabId)) persistThumbs();
  });
});

// ---- Saving -----------------------------------------------------------------

const OWN_PAGES = chrome.runtime.getURL("");

function worthSaving(url: string | undefined): url is string {
  return !!url && !url.startsWith(OWN_PAGES) && !/^chrome:\/\/(newtab|new-tab-page)/.test(url) && url !== "about:blank";
}

async function tabsFor(scope: Scope, windowId?: number): Promise<chrome.tabs.Tab[]> {
  const win = windowId ?? (await chrome.windows.getLastFocused()).id;
  const query: chrome.tabs.QueryInfo = { windowId: win };
  if (scope === "tab") query.active = true;
  if (scope === "highlighted") query.highlighted = true;
  return chrome.tabs.query(query);
}

const COLORS: Record<string, string> = {
  grey: "Grey", blue: "Blue", red: "Red", yellow: "Yellow", green: "Green", pink: "Pink", purple: "Purple", cyan: "Cyan", orange: "Orange",
};

async function save(scope: Scope, windowId: number | undefined, folder: string[], close: boolean): Promise<Tab[]> {
  await loadCore();
  await loadThumbs();
  const tabs = (await tabsFor(scope, windowId)).filter((t) => worthSaving(t.url));
  if (!tabs.length) throw new Error("There are no tabs here to save.");
  const groups = new Map<number, string>();
  if (scope !== "tab") {
    for (const id of new Set(tabs.map((t) => t.groupId).filter((g) => g !== chrome.tabGroups.TAB_GROUP_ID_NONE))) {
      const g = await chrome.tabGroups.get(id).catch(() => null);
      if (g) groups.set(id, g.title?.trim() || `${COLORS[g.color] ?? "Unnamed"} group`);
    }
  }
  const pictures = await picturesOn();
  const items = tabs.map((t) => {
    const thumb = pictures && t.id !== undefined ? thumbs.get(t.id) : undefined;
    return {
      url: t.url!,
      title: t.title ?? "",
      group: groups.get(t.groupId) ?? null,
      thumbnail: thumb && thumb.url === t.url ? thumb.data : null,
    };
  });
  const saved = (await core.save(await account(), folder, items, s3fetch)) as Tab[];
  await merge(saved);
  if (close) await closeTabs(tabs);
  return saved;
}

/** Closes saved tabs, leaving a window with the CleanTabs page if it would
 * otherwise close the last one. */
async function closeTabs(tabs: chrome.tabs.Tab[]): Promise<void> {
  const ids = tabs.map((t) => t.id!).filter((id) => id !== undefined);
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  const closing = new Set(ids);
  const left = windows.filter((w) => (w.tabs ?? []).some((t) => !closing.has(t.id!)));
  if (!left.length && tabs[0]) {
    await chrome.tabs.create({ windowId: tabs[0].windowId, url: chrome.runtime.getURL("tabs.html") });
  }
  await chrome.tabs.remove(ids);
}

// ---- Opening ----------------------------------------------------------------

/** Opens tabs in order: those right in `base` on their own, those in its
 * sub-folders as a tab group per sub-folder. */
async function open(tabs: Tab[], base: string[], newWindow: boolean): Promise<void> {
  if (!tabs.length) throw new Error("There are no tabs to open.");
  const groupOf = (t: Tab): string | null => {
    const inBase = base.length && base.every((s, i) => t.folder[i] === s);
    return inBase && t.folder.length > base.length ? t.folder[base.length] : null;
  };
  // Ungrouped first, then each group's tabs together.
  const order: Tab[] = [...tabs.filter((t) => !groupOf(t))];
  const groupNames = [...new Set(tabs.map(groupOf).filter((g): g is string => !!g))];
  for (const g of groupNames) order.push(...tabs.filter((t) => groupOf(t) === g));

  let windowId: number;
  const made: { tab: Tab; id: number }[] = [];
  let rest = order;
  if (newWindow) {
    const w = await chrome.windows.create({ url: order[0].url, focused: true });
    windowId = w!.id!;
    made.push({ tab: order[0], id: w!.tabs![0].id! });
    rest = order.slice(1);
  } else {
    windowId = (await chrome.windows.getLastFocused({ windowTypes: ["normal"] })).id!;
  }
  for (const [i, t] of rest.entries()) {
    try {
      const created = await chrome.tabs.create({ windowId, url: t.url, active: !newWindow && i === 0 });
      made.push({ tab: t, id: created.id! });
    } catch {
      // An address Chrome won't open from an extension (javascript:, …).
    }
  }
  for (const g of groupNames) {
    const ids = made.filter((m) => groupOf(m.tab) === g).map((m) => m.id);
    if (!ids.length) continue;
    const groupId = await chrome.tabs.group({ tabIds: ids as [number, ...number[]], createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: g, collapsed: false });
  }
}

// ---- Messages ---------------------------------------------------------------

const pictureCache = new Map<string, string | null>();

async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case "status": {
      const { account: a } = await chrome.storage.local.get("account");
      const acc = a as Account | undefined;
      const status: Status = {
        configured: !!acc,
        account: acc ? { bucket: acc.bucket, region: acc.region, prefix: acc.prefix, endpoint: acc.endpoint, access_key_id: acc.access_key_id } : null,
        encrypted: !!acc?.key,
        pictures: await picturesOn(),
      };
      return status;
    }
    case "connect": {
      await loadCore();
      const acc = { ...req.account, key: null };
      const r = (await core.connect(acc, req.passphrase || null, s3fetch)) as { encrypted: boolean; key: string | null };
      await chrome.storage.local.set({ account: { ...acc, key: r.key } });
      listing = null;
      await chrome.storage.local.remove("listing");
      pictureCache.clear();
      return refresh();
    }
    case "disconnect":
      listing = null;
      pictureCache.clear();
      await chrome.storage.local.remove(["account", "listing"]);
      return null;
    case "setPictures":
      await chrome.storage.local.set({ pictures: req.on });
      return picturesOn();
    case "list":
      if (!req.refresh) {
        const l = await cached();
        if (l) return l;
      }
      return refresh();
    case "save":
      return save(req.scope, req.windowId, req.folder, req.close);
    case "open": {
      const l = (await cached()) ?? (await refresh());
      let tabs = l.tabs.filter((t) => !t.deleted);
      if (req.stems) {
        const want = new Set(req.stems);
        tabs = tabs.filter((t) => want.has(t.stem));
      }
      if (req.folder) {
        const f = req.folder;
        tabs = tabs.filter((t) => f.every((s, i) => t.folder[i] === s));
      }
      await open(tabs, req.folder ?? [], req.newWindow);
      return null;
    }
    case "delete":
      await loadCore();
      return merge((await core.delete_tabs(await account(), req.stems.map((stem) => ({ stem })), s3fetch)) as Tab[]);
    case "recover":
      await loadCore();
      return merge((await core.recover(await account(), req.stems.map((stem) => ({ stem })), s3fetch)) as Tab[]);
    case "move":
      await loadCore();
      return merge((await core.move_to(await account(), req.stems.map((stem) => ({ stem })), req.folder, s3fetch)) as Tab[]);
    case "newFolder": {
      await loadCore();
      await core.new_folder(await account(), req.folder, s3fetch);
      const l = (await cached()) ?? { tabs: [], folders: [["Tabs"]] };
      const path = ["Tabs", ...req.folder.map((s) => s.trim().replace(/\//g, "-")).filter(Boolean)];
      const folders = [...l.folders];
      for (let n = 1; n <= path.length; n++) {
        if (!folders.some((f) => f.join("\u0000") === path.slice(0, n).join("\u0000"))) folders.push(path.slice(0, n));
      }
      folders.sort((a, b) => a.join("\u0000").localeCompare(b.join("\u0000")));
      return store({ ...l, folders });
    }
    case "thumbnail": {
      if (pictureCache.has(req.name)) return pictureCache.get(req.name);
      await loadCore();
      const bytes = (await core.thumbnail(await account(), req.name, s3fetch)) as Uint8Array | undefined;
      const url = bytes ? `data:image/jpeg;base64,${base64(bytes)}` : null;
      pictureCache.set(req.name, url);
      return url;
    }
  }
}

chrome.runtime.onMessage.addListener((req: Request, sender, sendResponse: (r: Reply) => void) => {
  // Only the extension's own pages.
  if (sender.id !== chrome.runtime.id || (sender.url && !sender.url.startsWith(OWN_PAGES))) return false;
  handle(req).then(
    (value) => sendResponse({ ok: true, value }),
    (e: unknown) => {
      const err = e instanceof Error ? e : new Error(String(e));
      sendResponse({ ok: false, error: err.message, name: err.name });
    },
  );
  return true;
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("tabs.html#settings") });
});
