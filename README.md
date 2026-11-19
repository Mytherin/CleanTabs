# CleanTabs

A Chrome extension that saves, organises and reopens tabs, and keeps them as **notes in [CleanNotes](https://github.com/Mytherin/CleanNotes)**: in the S3 folder of a CleanNotes account, under a **Tabs** folder. There's no server: like CleanNotes and CleanPassword, the extension talks to your S3 bucket directly.

- **Save** this tab, the selected tabs, or the whole window, into `Tabs / <folder>` (the popup, or Ctrl+Shift+S). A window's tab groups go into sub-folders: `Tabs / Research / Docs`. Optionally close the tabs once saved.
- **Pictures of pages** (optional): a small JPEG (384×240 at most, typically 10–20 KB) of each page, taken when it has loaded or is shown, saved with the tab. CleanNotes shows it as the note's picture.
- **Reopen** a folder as a window: its tabs in order, and each sub-folder as a tab group with that name. Or open single tabs, or the selection.
- **Organise** on the CleanTabs page: folders and sub-folders, drag tabs onto a folder, move or delete several at once, search titles, addresses and what you wrote about them, and Recently Deleted (CleanNotes' own, 30 days).
- **In CleanNotes** every tab is a note you can read, edit and add to. The text below its link is yours, and CleanTabs shows it on the tab's card.

## How tabs are kept

Each tab is a CleanNotes note, written exactly as CleanNotes writes its own notes (front matter + Markdown), so CleanNotes syncs and merges them like any other:

```text
<account folder>/notes/tab-<id>.md       one per tab
<account folder>/folders/<id>.json       Tabs, and its sub-folders
<account folder>/attachments/<sha256>.jpg  pictures of pages
<account folder>/head                    touched after every change
```

```markdown
---
id: tab-3f0c…
folder: [Tabs, Research, Docs]
created: 2026-11-19T21:58:00.000Z
modified: 2026-11-19T21:58:00.000Z
---
# The page's title

[example.com/some/page](https://example.com/some/page)

![](attachments/9b1f….jpg)

Anything written about it since, in CleanNotes.
```

- Ids start with `tab-`, so CleanNotes can show tab notes as previews of their pages and CleanTabs lists only its own notes.
- A saved window's notes are made a millisecond apart, and are reopened in that order.
- **Encrypted CleanNotes folders work too.** CleanTabs asks for the folder's passphrase once, makes the same key CleanNotes does (Argon2id), and seals notes, folders and pictures as CleanNotes does.

### Code shared with CleanNotes

Almost everything that touches the bucket is CleanNotes' own code: the `cleanbucket` crate in the CleanNotes repository (`bucket/`), whose `notes` module has the note format, the folder encryption, an async client for the folder, and the tab-note layout (`notes::tabs`). It's the same code CleanNotes' sync uses. This repository adds only:

- `wasm/`: the extension's view of it (save, list, move, delete, recover, pictures), built to WebAssembly. `cleanbucket` is a git dependency pinned to a CleanNotes revision.
- `extension/`: the extension itself (TypeScript): the service worker, the popup, and the CleanTabs page.

To work on both at once, point Cargo at a CleanNotes checkout in `.cargo/config.toml` (not committed):

```toml
[patch."https://github.com/Mytherin/CleanNotes"]
cleanbucket = { path = "../CleanNotes/bucket" }
```

## Setting up

1. Set up a CleanNotes account that syncs with S3 (CleanNotes → Settings → Accounts), if you haven't.
2. Install the extension (see Building), and enter the same bucket, region, folder (`CleanNotes` by default) and access key in CleanTabs' settings. If the folder is encrypted, it asks for the passphrase.
3. The access key needs what CleanNotes' does: `s3:ListBucket` on the bucket and `s3:GetObject` / `s3:PutObject` under the folder.
4. To save pictures of pages, turn them on in the settings; Chrome then asks to let CleanTabs read the pages you visit (taking a picture needs that).

**What's kept where.** The account settings, the access key and (for an encrypted folder) its key are in `chrome.storage.local`, which only the extension can read. A list of saved tabs is kept there too, so the pages open at once. Pictures not yet saved are kept in memory and `chrome.storage.session` until their tab is saved or closed.

## Building

Needs Rust with the `wasm32-unknown-unknown` target, `wasm-bindgen-cli` 0.2.100 (`cargo install wasm-bindgen-cli --version 0.2.100`) and Node.

```sh
cd extension
npm install
npm run build        # into extension/dist: load it at chrome://extensions ("Load unpacked")
npm test             # the extension in Chrome against a fake S3
cargo test           # (at the top) the core, against an in-memory S3
```
