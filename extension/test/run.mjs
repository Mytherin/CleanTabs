// The extension in a real Chrome, against a fake S3: saving a window with a
// tab group (and pictures of its pages) as tab notes, what lands in the
// bucket, opening the folder again as a window with its group, moving and
// deleting, and the pages rendering.
//
//   npm test    (builds first; CHROME=<path> to pick a browser)

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { startFakeS3 } from "./fake-s3.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${name}${ok || !detail ? "" : `\n        ${detail}`}`);
  if (!ok) failures++;
}

const chrome = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && existsSync(p));
if (!chrome) throw new Error("Chrome not found: set CHROME");

// ---- Pages to save -------------------------------------------------------------

const colors = { alpha: "#d33", beta: "#3a3", gamma: "#33d", delta: "#da3" };
const web = createServer((req, res) => {
  const name = new URL(req.url, "http://x").pathname.slice(1);
  const color = colors[name];
  res.writeHead(color ? 200 : 404, { "content-type": "text/html" });
  res.end(color ? `<!doctype html><title>Page ${name}</title><body style="margin:0;background:${color};font:40px sans-serif;color:#fff"><h1>${name}</h1>` : "no");
});
await new Promise((r) => web.listen(0, "127.0.0.1", r));
const WEB = `http://127.0.0.1:${web.address().port}`;
const s3 = await startFakeS3();

// The built extension, allowed to reach the fake S3, with the pages
// permission pictures need granted (a test can't click Chrome's prompt).
const ext = join(here, "dist-test");
rmSync(ext, { recursive: true, force: true });
cpSync(join(here, "..", "dist"), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8"));
manifest.host_permissions.push("http://127.0.0.1/*", "<all_urls>");
writeFileSync(join(ext, "manifest.json"), JSON.stringify(manifest, null, 2));

const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  enableExtensions: [ext],
  args: ["--no-first-run", "--no-default-browser-check", "--window-size=1280,900"],
  defaultViewport: { width: 1280, height: 900 },
});

const shots = join(here, "screenshots");
mkdirSync(shots, { recursive: true });

try {
  const sw = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 10000 });
  const id = new URL(sw.url()).host;
  const ctl = await browser.newPage();
  await ctl.goto(`chrome-extension://${id}/popup.html`);
  const ask = (type, args = {}) => ctl.evaluate((m) => chrome.runtime.sendMessage(m), { type, ...args });
  const value = async (type, args) => {
    const r = await ask(type, args);
    if (!r.ok) throw new Error(`${type}: ${r.error}`);
    return r.value;
  };

  console.log("Connecting");
  const account = { bucket: "bucket", region: "us-east-1", prefix: "CleanNotes", endpoint: `http://127.0.0.1:${s3.port}`, access_key_id: "AK", secret_access_key: "SK" };
  const empty = await value("connect", { account });
  check("an empty account lists no tabs", empty.tabs.length === 0 && JSON.stringify(empty.folders) === '[["Tabs"]]', JSON.stringify(empty));
  check("pictures can be turned on", (await value("setPictures", { on: true })) === true);

  console.log("Saving a window");
  const win = await ctl.evaluate(async (urls) => {
    const w = await chrome.windows.create({ url: urls, focused: true });
    return w.id;
  }, ["alpha", "beta", "gamma", "delta"].map((n) => `${WEB}/${n}`));
  const tabIds = await ctl.evaluate(async (w) => (await chrome.tabs.query({ windowId: w })).map((t) => t.id), win);
  await ctl.evaluate(async (w, ids) => {
    const g = await chrome.tabs.group({ tabIds: ids.slice(2), createProperties: { windowId: w } });
    await chrome.tabGroups.update(g, { title: "Docs", color: "blue" });
  }, win, tabIds);
  // Show each tab, so it's captured.
  for (const t of tabIds) {
    await ctl.evaluate((t) => chrome.tabs.update(t, { active: true }), t);
    await sleep(1600);
  }
  const saved = await value("save", { scope: "window", windowId: win, folder: ["Research"], close: true });
  check("four tabs saved", saved.length === 4, JSON.stringify(saved.map((t) => t.title)));
  check("in Tabs / Research, the group's in Tabs / Research / Docs",
    JSON.stringify(saved.map((t) => t.folder.join("/"))) === JSON.stringify(["Tabs/Research", "Tabs/Research", "Tabs/Research/Docs", "Tabs/Research/Docs"]),
    JSON.stringify(saved.map((t) => t.folder)));
  const pictured = saved.filter((t) => t.thumbnail).length;
  check("tabs shown before saving have pictures", pictured >= 3, `${pictured} of 4`);
  check("the window was closed", !(await ctl.evaluate(async (w) => (await chrome.windows.getAll()).some((x) => x.id === w), win)));

  console.log("What's in the bucket");
  const objects = [...s3.objects.entries()].map(([k, v]) => [k.replace(/^bucket\/CleanNotes\//, ""), v.body]);
  const notes = objects.filter(([k]) => k.startsWith("notes/tab-"));
  check("one note per tab", notes.length === 4, objects.map(([k]) => k).join(", "));
  const alpha = notes.map(([, b]) => b.toString()).find((t) => t.includes("Page alpha"));
  check("a tab note is CleanNotes' format", /^---\nid: tab-[0-9a-f]{32}\nfolder: \[Tabs, Research\]\ncreated: .*Z\nmodified: .*Z\n---\n# Page alpha\n\n\[127\.0\.0\.1:\d+\/alpha\]\(http:\/\/127\.0\.0\.1:\d+\/alpha\)\n\n!\[\]\(attachments\/[0-9a-f]{64}\.jpg\)\n$/.test(alpha ?? ""), alpha);
  const folders = objects.filter(([k]) => k.startsWith("folders/")).map(([, b]) => b.toString()).sort();
  check("folder objects for Tabs and below", JSON.stringify(folders) === JSON.stringify(['["Tabs","Research","Docs"]', '["Tabs","Research"]', '["Tabs"]']), JSON.stringify(folders));
  const pics = objects.filter(([k]) => k.startsWith("attachments/"));
  check("pictures are small JPEGs", pics.length >= 3 && pics.every(([, b]) => b[0] === 0xff && b[1] === 0xd8 && b.length < 60_000), pics.map(([, b]) => b.length).join(", "));
  console.log(`        (pictures: ${pics.map(([, b]) => `${(b.length / 1024).toFixed(1)} KB`).join(", ")})`);
  check("head was touched", objects.some(([k]) => k === "head"));

  console.log("Opening the folder again");
  const before = await ctl.evaluate(async () => (await chrome.windows.getAll()).map((w) => w.id));
  await value("open", { folder: ["Tabs", "Research"], newWindow: true });
  await sleep(1000);
  const reopened = await ctl.evaluate(async (before) => {
    const w = (await chrome.windows.getAll({ populate: true })).find((w) => !before.includes(w.id));
    const groups = await chrome.tabGroups.query({ windowId: w.id });
    return { urls: w.tabs.map((t) => t.url), grouped: w.tabs.filter((t) => t.groupId !== -1).map((t) => t.url), titles: groups.map((g) => g.title) };
  }, before);
  check("a new window with the four tabs, in order", JSON.stringify(reopened.urls) === JSON.stringify(["alpha", "beta", "gamma", "delta"].map((n) => `${WEB}/${n}`)), JSON.stringify(reopened.urls));
  check("the Docs group is back", JSON.stringify(reopened.titles) === '["Docs"]' && reopened.grouped.length === 2, JSON.stringify(reopened));

  console.log("Organising");
  const beta = saved.find((t) => t.title === "Page beta");
  const gamma = saved.find((t) => t.title === "Page gamma");
  await value("move", { stems: [beta.stem], folder: ["Later"] });
  await value("delete", { stems: [gamma.stem] });
  const l = await value("list", { refresh: true });
  const find = (s) => l.tabs.find((t) => t.stem === s);
  check("moved to Tabs / Later", find(beta.stem)?.folder.join("/") === "Tabs/Later");
  check("deleted to Recently Deleted", !!find(gamma.stem)?.deleted);
  check("Tabs / Later is listed", l.folders.some((f) => f.join("/") === "Tabs/Later"), JSON.stringify(l.folders));
  const gammaNote = s3.objects.get(`bucket/CleanNotes/notes/${gamma.stem}.md`).body.toString();
  check("deleting sets the note's deleted time, as CleanNotes does", /\ndeleted: .*Z\n/.test(gammaNote), gammaNote);

  console.log("The pages");
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${id}/tabs.html#${encodeURIComponent(JSON.stringify(["Tabs", "Research"]))}`);
  await page.waitForSelector(".card");
  await sleep(1500);
  const cards = await page.$$eval(".card", (cs) => cs.map((c) => ({ title: c.querySelector(".title").textContent, pic: c.querySelector(".shot").style.backgroundImage.startsWith('url("data:image/jpeg') })));
  check("Research shows its two live tabs as cards", cards.length === 2, JSON.stringify(cards));
  check("cards show the pictures", cards.filter((c) => c.pic).length >= 1, JSON.stringify(cards));
  const sections = await page.$$eval("h2.group", (hs) => hs.map((h) => h.textContent));
  check("the Docs sub-folder is a section", sections.length === 1 && sections[0].startsWith("Docs"), JSON.stringify(sections));
  await page.screenshot({ path: join(shots, "tabs.png") });
  await page.goto(`chrome-extension://${id}/tabs.html#deleted`);
  await page.waitForSelector(".card");
  check("Recently Deleted shows the deleted tab", (await page.$$(".card")).length === 1);
  await page.setViewport({ width: 360, height: 520 });
  await page.goto(`chrome-extension://${id}/popup.html`);
  await page.waitForSelector("#recent button");
  await page.screenshot({ path: join(shots, "popup.png") });
  check("the popup lists recent tabs", (await page.$$("#recent button")).length === 3);
} catch (e) {
  console.error(e);
  failures++;
} finally {
  await browser.close();
  web.close();
  s3.server.close();
}

console.log(failures ? `\n${failures} failed` : "\nAll passed");
process.exit(failures ? 1 : 0);
