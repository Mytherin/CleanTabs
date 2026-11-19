# CleanTabs

A Chrome extension that saves, organises and reopens tabs, and keeps them as **notes for [CleanNotes](https://github.com/Mytherin/CleanNotes)**: in a `tabs/` directory of a CleanNotes account's S3 folder, which CleanNotes shows as a section of its own, **CleanTabs** (like CleanPassword's, but not locked), with the tabs as a gallery of web pages, apart from your notes. There's no server: like CleanNotes and CleanPassword, the extension talks to your S3 bucket directly.

- **Save** this tab, the selected tabs, or the whole window, into a collection: `Research` (the popup, or Ctrl+Shift+S). A window's tab groups go into sub-folders: `Research / Docs`. Optionally close the tabs once saved.
- **Pictures of pages** (optional): a small JPEG (384×240 at most, typically 10–20 KB) of each page, taken when it has loaded or is shown, saved with the tab. CleanNotes shows it as the tab's picture.
- **Reopen** a collection as a window: its tabs in order, and each sub-folder as a tab group with that name. Or open single tabs, or the selection.
- **Organise** on the CleanTabs page: collections and sub-folders, drag tabs onto a folder, move or delete several at once, search titles, addresses and what you wrote about them, and Recently Deleted (30 days, as in CleanNotes).
- **In CleanNotes** every tab is a note you can read and add to, in the CleanTabs section. The text below its link is yours, and CleanTabs shows it on the tab's card.

## How tabs are kept

The tabs live in the account folder's `tabs/` directory, next to the notes' own `notes/` and `folders/`, laid out exactly like a CleanNotes folder. CleanNotes syncs it with its own sync, as a linked source of the account, and never mixes it with your notes (its notes sync reads only `notes/` and `folders/`):

```text
<account folder>/notes/ folders/ attachments/ head   your notes
<account folder>/tabs/head                           touched after every change
<account folder>/tabs/notes/tab-<id>.md              one per tab
<account folder>/tabs/folders/<id>.json              collections and their sub-folders
<account folder>/tabs/attachments/<sha256>.jpg       pictures of pages
```

(With the notes at the top of the bucket, that's `<bucket>/tabs/…`.) Each tab is a note written exactly as CleanNotes writes its own:

```markdown
---
id: tab-3f0c…
folder: [Research, Docs]
created: 2026-11-19T21:58:00.000Z
modified: 2026-11-19T21:58:00.000Z
---
# The page's title

[example.com/some/page](https://example.com/some/page)

![](attachments/9b1f….jpg)

Anything written about it since, in CleanNotes.
```

- Ids start with `tab-`.
- A saved window's notes are made a millisecond apart, and are reopened in that order.
- **Encrypted CleanNotes folders work too.** CleanTabs asks for the folder's passphrase once and makes the same key CleanNotes does (Argon2id, from the folder's `encryption.json`). The tabs are sealed with that key, as CleanNotes seals notes, so CleanNotes opens them with the key it has.
- The first versions kept tabs among the account's notes (under a `Tabs` or `CleanTabs` folder). CleanTabs moves those into `tabs/`, with their pictures, the next time it reads the account.

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
2. Install the extension (see Building), and enter the same bucket, region, folder (`CleanNotes` by default; empty if your notes are at the top of the bucket) and access key in CleanTabs' settings. The tabs go in that folder's `tabs/`. If the folder is encrypted, it asks for the passphrase.
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
