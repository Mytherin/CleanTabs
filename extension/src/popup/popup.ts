// The toolbar popup: save this tab or window to a folder under Tabs.

import { ask, defaultFolderName, underTabs, type Listing, type Scope, type Status } from "../shared/types";
import { $, el, favicon, parseFolder, showFolder } from "../shared/ui";

const READING_LIST = "Reading List";

function openPage(hash = ""): void {
  void chrome.tabs.create({ url: chrome.runtime.getURL(`tabs.html${hash}`) });
  window.close();
}

function fill(l: Listing): void {
  const list = $("folders");
  list.replaceChildren(...l.folders.map(underTabs).filter((f): f is string[] => !!f && f.length > 0).map((f) => el("option", { value: showFolder(f) })));
  const recent = l.tabs.filter((t) => !t.deleted).slice(-6).reverse();
  $("recent").replaceChildren(
    ...(recent.length
      ? recent.map((t) => {
          const b = el("button", { title: t.url }, el("img", { src: favicon(t.url), alt: "" }), el("span", {}, t.title || t.url));
          b.onclick = () => void chrome.tabs.create({ url: t.url });
          return b;
        })
      : [el("p", { className: "muted small" }, "Nothing saved yet.")]),
  );
}

async function save(scope: Scope): Promise<void> {
  const msg = $("msg");
  const typed = parseFolder(($("folder") as HTMLInputElement).value);
  const folder = typed.length ? typed : [scope === "tab" ? READING_LIST : defaultFolderName()];
  const buttons = document.querySelectorAll<HTMLButtonElement>("[data-scope]");
  buttons.forEach((b) => (b.disabled = true));
  msg.textContent = "";
  try {
    const win = await chrome.windows.getCurrent();
    const close = ($("close") as HTMLInputElement).checked;
    const saved = await ask<unknown[]>({ type: "save", scope, windowId: win.id, folder, close });
    msg.classList.remove("error");
    msg.textContent = `Saved ${saved.length} ${saved.length === 1 ? "tab" : "tabs"} to CleanTabs / ${showFolder(folder)}.`;
    fill(await ask<Listing>({ type: "list", refresh: false }));
  } catch (e) {
    msg.classList.add("error");
    msg.textContent = (e as Error).message;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function main(): Promise<void> {
  $("manage").onclick = () => openPage();
  $("setupBtn").onclick = () => openPage("#settings");
  const status = await ask<Status>({ type: "status" });
  if (!status.configured) {
    $("setup").hidden = false;
    return;
  }
  $("main").hidden = false;
  ($("folder") as HTMLInputElement).placeholder = `${defaultFolderName()} (one tab: ${READING_LIST})`;
  ($("close") as HTMLInputElement).checked = (await chrome.storage.local.get("closeAfterSave")).closeAfterSave === true;
  $("close").onchange = () => void chrome.storage.local.set({ closeAfterSave: ($("close") as HTMLInputElement).checked });
  document.querySelectorAll<HTMLButtonElement>("[data-scope]").forEach((b) => (b.onclick = () => void save(b.dataset.scope as Scope)));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const highlighted = await chrome.tabs.query({ highlighted: true, currentWindow: true });
  if (highlighted.length > 1) {
    const b = el("button", { className: "btn" }, `Save ${highlighted.length} selected tabs`);
    b.style.gridColumn = "1 / -1";
    b.onclick = () => void save("highlighted");
    document.querySelector(".buttons")!.append(b);
  } else if (!tab?.url || !/^(https?|file|ftp):/.test(tab.url)) {
    (document.querySelector("[data-scope=tab]") as HTMLButtonElement).disabled = true;
  }
  try {
    fill(await ask<Listing>({ type: "list", refresh: false }));
  } catch (e) {
    $("msg").textContent = (e as Error).message;
  }
}

void main();
