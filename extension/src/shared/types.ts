// What the pages and the service worker pass each other.

/** A CleanNotes S3 account (its settings in CleanNotes). */
export interface Account {
  bucket: string;
  region: string;
  /** The account's folder in the bucket: `CleanNotes` unless changed. */
  prefix: string;
  /** An S3-compatible service's address (R2, MinIO); empty for Amazon S3. */
  endpoint?: string | null;
  access_key_id: string;
  secret_access_key: string;
  /** The folder's encryption key (base64), when it's encrypted. */
  key?: string | null;
}

/** A saved tab: a tab note in CleanNotes. */
export interface Tab {
  stem: string;
  etag: string;
  id: string;
  /** Its note's folder from the top: `[ROOT, "Reading"]`. */
  folder: string[];
  created: string;
  modified: string;
  deleted: string | null;
  title: string;
  url: string;
  /** A picture of the page: an attachment's name. */
  thumbnail: string | null;
  /** What's been written about it in CleanNotes. */
  text: string;
}

export interface Listing {
  tabs: Tab[];
  /** Folders under (and including) `Tabs`, from the top. */
  folders: string[][];
}

/** The tabs a save takes. */
export type Scope = "tab" | "window" | "highlighted";

export type Request =
  | { type: "status" }
  | { type: "connect"; account: Account; passphrase?: string }
  | { type: "disconnect" }
  | { type: "setPictures"; on: boolean }
  | { type: "list"; refresh: boolean }
  | { type: "save"; scope: Scope; windowId?: number; folder: string[]; close: boolean }
  | { type: "open"; folder?: string[]; stems?: string[]; newWindow: boolean }
  | { type: "delete"; stems: string[] }
  | { type: "recover"; stems: string[] }
  | { type: "move"; stems: string[]; folder: string[] }
  | { type: "newFolder"; folder: string[] }
  | { type: "thumbnail"; name: string };

export interface Status {
  configured: boolean;
  account: Omit<Account, "secret_access_key" | "key"> | null;
  encrypted: boolean;
  pictures: boolean;
}

/** Replies are `{ok: true, value}` or `{ok: false, error, name?}`. */
export type Reply<T = unknown> = { ok: true; value: T } | { ok: false; error: string; name?: string };

export async function ask<T>(req: Request): Promise<T> {
  const r = (await chrome.runtime.sendMessage(req)) as Reply<T> | undefined;
  if (!r) throw new Error("CleanTabs didn't answer; try again");
  if (!r.ok) {
    const e = new Error(r.error);
    if (r.name) e.name = r.name;
    throw e;
  }
  return r.value;
}

/** The CleanNotes folder saved tabs are kept in (`cleanbucket::notes::tabs::FOLDER`).
 * CleanNotes shows it as its own CleanTabs section, apart from the notes. */
export const ROOT = "CleanTabs";

/** The folder's path below ROOT, or `null` if it isn't under it. */
export function underTabs(folder: string[]): string[] | null {
  return folder[0] === ROOT ? folder.slice(1) : null;
}

/** How a folder is shown: "All Tabs" for ROOT, else its path below it. */
export function folderLabel(folder: string[]): string {
  const rel = underTabs(folder) ?? folder;
  return rel.length ? rel.join(" / ") : "All Tabs";
}

export function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** A name for a saved window: "Window, 19 Nov 21:58". */
export function defaultFolderName(d = new Date()): string {
  const date = d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return `Window, ${date} ${time}`;
}
