// The CleanTabs page: saved tabs as previews of their pages, by folder
// (Tabs and its sub-folders in CleanNotes), and the settings.

import { ask, host, underTabs, type Account, type Listing, type Status, type Tab } from "../shared/types";
import { $, el, favicon, parseFolder, showFolder } from "../shared/ui";

type View = { kind: "folder"; path: string[] } | { kind: "trash" } | { kind: "settings" };

let listing: Listing = { tabs: [], folders: [["Tabs"]] };
let view: View = { kind: "folder", path: ["Tabs"] };
const selected = new Set<string>();
let query = "";

const key = (p: string[]) => p.join("\u0000");
const within = (t: Tab, path: string[]) => path.every((s, i) => t.folder[i] === s);
const live = () => listing.tabs.filter((t) => !t.deleted);

function setError(text = ""): void {
  $("error").textContent = text;
}

async function run(what: string, f: () => Promise<unknown>): Promise<void> {
  setError();
  $("status").textContent = what;
  try {
    await f();
  } catch (e) {
    setError((e as Error).message);
  } finally {
    $("status").textContent = "";
  }
}

// ---- The sidebar -------------------------------------------------------------

function navItem(label: string, current: boolean, onClick: () => void, count?: number, depth = 0): HTMLButtonElement {
  const b = el("button", { className: `nav-item${current ? " current" : ""}` }, label);
  b.style.paddingLeft = `${8 + depth * 14}px`;
  if (count !== undefined) b.append(el("span", { className: "n" }, String(count)));
  b.onclick = onClick;
  return b;
}

function renderNav(): void {
  const items = listing.folders
    .filter((f) => f[0] === "Tabs")
    .map((f) => {
      const n = live().filter((t) => within(t, f)).length;
      const isCurrent = view.kind === "folder" && key(view.path) === key(f);
      const b = navItem(f[f.length - 1], isCurrent, () => go({ kind: "folder", path: f }), n, f.length - 1);
      // Drop tabs on a folder to move them there.
      b.ondragover = (e) => {
        if (e.dataTransfer?.types.includes("application/x-cleantabs")) {
          e.preventDefault();
          b.classList.add("drop");
        }
      };
      b.ondragleave = () => b.classList.remove("drop");
      b.ondrop = (e) => {
        e.preventDefault();
        b.classList.remove("drop");
        const stems = JSON.parse(e.dataTransfer!.getData("application/x-cleantabs")) as string[];
        void move(stems, f);
      };
      return b;
    });
  $("folders").replaceChildren(...items);
  const deleted = listing.tabs.filter((t) => t.deleted).length;
  const trash = $("trashNav");
  trash.className = `nav-item${view.kind === "trash" ? " current" : ""}`;
  trash.replaceChildren("Recently Deleted", el("span", { className: "n" }, deleted ? String(deleted) : ""));
  $("settingsNav").className = `nav-item${view.kind === "settings" ? " current" : ""}`;
}

// ---- Tabs ------------------------------------------------------------------

const pictures = new Map<string, Promise<string | null>>();
const observer = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    const shot = e.target as HTMLElement;
    observer.unobserve(shot);
    const name = shot.dataset.thumb!;
    if (!pictures.has(name)) pictures.set(name, ask<string | null>({ type: "thumbnail", name }).catch(() => null));
    void pictures.get(name)!.then((url) => {
      if (url) {
        shot.style.backgroundImage = `url("${url}")`;
        shot.replaceChildren();
      }
    });
  }
}, { rootMargin: "300px" });

function card(t: Tab): HTMLElement {
  const shot = el("div", { className: "shot" }, el("img", { className: "big", src: favicon(t.url, 64), alt: "" }));
  if (t.thumbnail) {
    shot.dataset.thumb = t.thumbnail;
    observer.observe(shot);
  }
  const check = el("input", { type: "checkbox", checked: selected.has(t.stem), title: "Select" });
  const body = el(
    "div",
    { className: "body" },
    el("div", { className: "title" }, t.title || t.url),
    el("div", { className: "site" }, el("img", { src: favicon(t.url), alt: "" }), el("span", {}, host(t.url))),
  );
  if (t.text.trim()) body.append(el("div", { className: "text" }, t.text.trim()));
  const c = el("div", { className: `card${selected.has(t.stem) ? " selected" : ""}`, title: t.url, draggable: true }, shot, body, check);
  const toggle = () => {
    if (selected.has(t.stem)) selected.delete(t.stem);
    else selected.add(t.stem);
    render();
  };
  check.onclick = (e) => {
    e.stopPropagation();
    toggle();
  };
  c.onclick = (e) => {
    if (e.ctrlKey || e.metaKey || e.shiftKey || selected.size) toggle();
    else void chrome.tabs.create({ url: t.url, active: true });
  };
  c.onauxclick = (e) => {
    if (e.button === 1) void chrome.tabs.create({ url: t.url, active: false });
  };
  c.ondragstart = (e) => {
    const stems = selected.has(t.stem) ? [...selected] : [t.stem];
    e.dataTransfer!.setData("application/x-cleantabs", JSON.stringify(stems));
    e.dataTransfer!.setData("text/uri-list", t.url);
  };
  return c;
}

function grid(tabs: Tab[]): HTMLElement {
  return el("div", { className: "grid" }, ...tabs.map(card));
}

function matches(t: Tab): boolean {
  const q = query.toLowerCase();
  return !q || [t.title, t.url, t.text, ...t.folder].some((s) => s.toLowerCase().includes(q));
}

function renderContent(): void {
  const content = $("content");
  const inTrash = view.kind === "trash";
  $("actions").hidden = inTrash;
  if (view.kind === "settings") return;
  let shown: Tab[];
  if (view.kind === "trash") {
    $("title").textContent = "Recently Deleted";
    shown = listing.tabs.filter((t) => t.deleted && matches(t));
    content.replaceChildren(shown.length ? grid(shown) : el("p", { className: "empty" }, "Deleted tabs stay here for 30 days (in CleanNotes' Recently Deleted)."));
  } else if (query) {
    $("title").textContent = `Search: ${query}`;
    shown = live().filter(matches);
    content.replaceChildren(shown.length ? grid(shown) : el("p", { className: "empty" }, "No saved tabs match."));
  } else {
    const path = view.path;
    $("title").textContent = showFolder(path);
    shown = live().filter((t) => within(t, path));
    const here = shown.filter((t) => t.folder.length === path.length);
    const sections: Node[] = here.length ? [grid(here)] : [];
    // Each sub-folder (a tab group, when saved with its window) on its own.
    const subs = [...new Set(shown.filter((t) => t.folder.length > path.length).map((t) => t.folder[path.length]))];
    for (const s of subs) {
      const sub = [...path, s];
      const tabs = shown.filter((t) => within(t, sub));
      const openBtn = el("button", { className: "link" }, "Open as window");
      openBtn.onclick = () => void run("Opening…", () => ask({ type: "open", folder: sub, newWindow: true }));
      const name = el("button", { className: "link" }, s);
      name.onclick = () => go({ kind: "folder", path: sub });
      sections.push(el("h2", { className: "group" }, name, el("span", {}, `${tabs.length}`), openBtn), grid(tabs));
    }
    content.replaceChildren(...(sections.length ? sections : [el("p", { className: "empty" }, "No tabs here yet. Save some with the CleanTabs button in Chrome's toolbar, or drag tabs here from another folder.")]));
  }
  $("count").textContent = `${shown.length} ${shown.length === 1 ? "tab" : "tabs"}`;
  ($("openAll") as HTMLButtonElement).disabled = !shown.length;
  ($("openHere") as HTMLButtonElement).disabled = !shown.length;
}

function renderSelection(): void {
  for (const s of [...selected]) if (!listing.tabs.some((t) => t.stem === s)) selected.delete(s);
  const bar = $("selection");
  bar.hidden = !selected.size || view.kind === "settings";
  document.body.classList.toggle("selecting", selected.size > 0);
  $("selCount").textContent = `${selected.size} selected`;
  const inTrash = view.kind === "trash";
  $("selRecover").hidden = !inTrash;
  $("selDelete").hidden = inTrash;
  $("selOpen").hidden = inTrash;
  const moveTo = $("moveTo") as HTMLSelectElement;
  moveTo.replaceChildren(
    el("option", { value: "" }, "Move to…"),
    ...listing.folders.filter((f) => f[0] === "Tabs").map((f) => el("option", { value: JSON.stringify(f) }, showFolder(f))),
    el("option", { value: "new" }, "New folder…"),
  );
}

function render(): void {
  renderNav();
  $("browse").hidden = view.kind === "settings";
  $("settings").hidden = view.kind !== "settings";
  renderContent();
  renderSelection();
}

function go(v: View): void {
  if (v.kind !== view.kind) selected.clear();
  view = v;
  query = "";
  ($("search") as HTMLInputElement).value = "";
  const hash = v.kind === "settings" ? "#settings" : v.kind === "trash" ? "#deleted" : `#${encodeURIComponent(JSON.stringify(v.path))}`;
  if (location.hash !== hash) history.pushState(null, "", hash);
  render();
}

async function load(refresh: boolean): Promise<void> {
  listing = await ask<Listing>({ type: "list", refresh });
  if (view.kind === "folder" && !listing.folders.some((f) => key(f) === key((view as { path: string[] }).path))) view = { kind: "folder", path: ["Tabs"] };
  render();
}

async function move(stems: string[], folder: string[]): Promise<void> {
  const rel = underTabs(folder) ?? folder;
  await run("Moving…", async () => {
    listing = await ask<Listing>({ type: "move", stems, folder: rel });
    selected.clear();
    render();
  });
}

function askFolderName(under: string[]): string[] | null {
  const name = prompt(`A new folder in ${showFolder(under)} (use "/" for folders inside it):`);
  if (!name) return null;
  const parts = parseFolder(name);
  return parts.length ? [...under, ...parts] : null;
}

// ---- Settings --------------------------------------------------------------

async function showSettings(): Promise<void> {
  const status = await ask<Status>({ type: "status" });
  const form = $("form") as HTMLFormElement;
  if (status.account) {
    for (const [k, v] of Object.entries(status.account)) {
      const input = form.elements.namedItem(k) as HTMLInputElement | null;
      if (input && typeof v === "string") input.value = v;
    }
    $("connected").textContent = `Connected${status.encrypted ? " (encrypted folder)" : ""}.`;
  }
  $("disconnect").hidden = !status.configured;
  ($("pictures") as HTMLInputElement).checked = status.pictures;
}

async function connect(e: SubmitEvent): Promise<void> {
  e.preventDefault();
  const form = $("form") as HTMLFormElement;
  const data = Object.fromEntries(new FormData(form)) as Record<string, string>;
  const account: Account = {
    bucket: data.bucket.trim(),
    region: data.region.trim() || "us-east-1",
    prefix: data.prefix.trim(),
    endpoint: data.endpoint.trim() || null,
    access_key_id: data.access_key_id.trim(),
    secret_access_key: data.secret_access_key.trim(),
  };
  const err = $("formError");
  err.textContent = "";
  // Another S3 service needs permission to talk to it.
  if (account.endpoint) {
    let origin: string;
    try {
      origin = new URL(account.endpoint).origin;
    } catch {
      err.textContent = "That address isn't valid.";
      return;
    }
    if (!(await chrome.permissions.request({ origins: [`${origin}/*`] }))) {
      err.textContent = "CleanTabs needs permission to reach that address.";
      return;
    }
  }
  const button = $("connect") as HTMLButtonElement;
  button.disabled = true;
  $("connected").textContent = data.passphrase ? "Unlocking the folder… (a few seconds)" : "Connecting…";
  try {
    listing = await ask<Listing>({ type: "connect", account, passphrase: data.passphrase || undefined });
    $("passLabel").hidden = true;
    (form.elements.namedItem("passphrase") as HTMLInputElement).value = "";
    await showSettings();
    go({ kind: "folder", path: ["Tabs"] });
  } catch (x) {
    const error = x as Error;
    $("connected").textContent = "";
    if (error.name === "NeedsPassphrase" || error.name === "WrongPassphrase") $("passLabel").hidden = false;
    err.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

// ---- Start -----------------------------------------------------------------

function viewFromHash(): View {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h === "settings") return { kind: "settings" };
  if (h === "deleted") return { kind: "trash" };
  try {
    const p = JSON.parse(h);
    if (Array.isArray(p) && p[0] === "Tabs") return { kind: "folder", path: p };
  } catch {
    // The top.
  }
  return { kind: "folder", path: ["Tabs"] };
}

async function main(): Promise<void> {
  $("trashNav").onclick = () => go({ kind: "trash" });
  $("settingsNav").onclick = () => {
    go({ kind: "settings" });
    void showSettings();
  };
  $("search").oninput = () => {
    query = ($("search") as HTMLInputElement).value.trim();
    renderContent();
  };
  $("refresh").onclick = () => void run("Reading…", () => load(true));
  $("openAll").onclick = () => void run("Opening…", () => ask({ type: "open", folder: view.kind === "folder" && !query ? view.path : undefined, stems: query ? live().filter(matches).map((t) => t.stem) : undefined, newWindow: true }));
  $("openHere").onclick = () => void run("Opening…", () => ask({ type: "open", folder: view.kind === "folder" && !query ? view.path : undefined, stems: query ? live().filter(matches).map((t) => t.stem) : undefined, newWindow: false }));
  $("newFolder").onclick = () => {
    const path = askFolderName(view.kind === "folder" ? view.path : ["Tabs"]);
    if (!path) return;
    void run("Making the folder…", async () => {
      listing = await ask<Listing>({ type: "newFolder", folder: path.slice(1) });
      go({ kind: "folder", path });
    });
  };
  $("selClear").onclick = () => {
    selected.clear();
    render();
  };
  $("selOpen").onclick = () => void run("Opening…", () => ask({ type: "open", stems: [...selected], newWindow: false }));
  $("selDelete").onclick = () =>
    void run("Deleting…", async () => {
      listing = await ask<Listing>({ type: "delete", stems: [...selected] });
      selected.clear();
      render();
    });
  $("selRecover").onclick = () =>
    void run("Recovering…", async () => {
      listing = await ask<Listing>({ type: "recover", stems: [...selected] });
      selected.clear();
      render();
    });
  $("moveTo").onchange = () => {
    const v = ($("moveTo") as HTMLSelectElement).value;
    ($("moveTo") as HTMLSelectElement).value = "";
    if (!v) return;
    const target = v === "new" ? askFolderName(["Tabs"]) : (JSON.parse(v) as string[]);
    if (target) void move([...selected], target);
  };
  ($("form") as HTMLFormElement).onsubmit = (e) => void connect(e);
  $("disconnect").onclick = async () => {
    if (!confirm("Disconnect CleanTabs from this account? Saved tabs stay in CleanNotes.")) return;
    await ask({ type: "disconnect" });
    listing = { tabs: [], folders: [["Tabs"]] };
    $("connected").textContent = "";
    await showSettings();
  };
  $("pictures").onchange = async () => {
    const box = $("pictures") as HTMLInputElement;
    // Asked here, while the click still counts as the user's.
    const granted = box.checked ? await chrome.permissions.request({ origins: ["<all_urls>"] }) : true;
    box.checked = await ask<boolean>({ type: "setPictures", on: box.checked && granted });
  };
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && selected.size) {
      selected.clear();
      render();
    } else if ((e.key === "Delete" || e.key === "Backspace") && selected.size && view.kind === "folder" && !(e.target instanceof HTMLInputElement)) {
      $("selDelete").click();
    }
  });

  // Back, forward, and links to a folder.
  window.addEventListener("hashchange", () => {
    const v = viewFromHash();
    go(v);
    if (v.kind === "settings") void showSettings();
  });

  view = viewFromHash();
  const status = await ask<Status>({ type: "status" });
  if (!status.configured) view = { kind: "settings" };
  render();
  if (view.kind === "settings") await showSettings();
  if (status.configured) {
    await run("", () => load(false));
    await run("Reading…", () => load(true));
  }
}

void main();
