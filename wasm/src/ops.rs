//! What the extension asks of a CleanNotes S3 folder, over any transport
//! (so it's tested here with an in-memory S3).

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use chrono::{DateTime, Duration, Utc};
use cleanbucket::notes::tabs::{self, TabNote};
use cleanbucket::notes::{self, crypto, format, Folder, NoteData, StoredNote, NOTES};
use cleanbucket::s3::{Client, Credentials, Location, Transport};
use cleanbucket::{Error, Result};
use futures::future::join_all;
use serde::{Deserialize, Serialize};

/// Requests at once.
const PARALLEL: usize = 8;
/// The largest picture of a page accepted.
const MAX_THUMBNAIL: usize = 512 * 1024;

/// A CleanNotes S3 account, as the extension keeps it.
#[derive(Clone, Debug, Deserialize)]
pub struct Account {
    pub bucket: String,
    pub region: String,
    /// The CleanNotes account's folder in the bucket (`CleanNotes`).
    pub prefix: String,
    #[serde(default)]
    pub endpoint: Option<String>,
    pub access_key_id: String,
    pub secret_access_key: String,
    #[serde(default)]
    pub session_token: Option<String>,
    /// The folder's encryption key (base64), when it's encrypted.
    #[serde(default)]
    pub key: Option<String>,
}

impl Account {
    pub fn location(&self) -> Location {
        Location {
            bucket: self.bucket.trim().to_owned(),
            region: self.region.trim().to_owned(),
            prefix: self.prefix.trim().trim_matches('/').to_owned(),
            endpoint: self.endpoint.clone().filter(|e| !e.trim().is_empty()),
        }
    }

    pub fn credentials(&self) -> Credentials {
        Credentials {
            access_key_id: self.access_key_id.trim().to_owned(),
            secret_access_key: self.secret_access_key.trim().to_owned(),
            session_token: self.session_token.clone().filter(|t| !t.trim().is_empty()),
        }
    }

    pub fn key(&self) -> Result<Option<[u8; 32]>> {
        match &self.key {
            None => Ok(None),
            Some(k) => {
                let b = B64.decode(k.trim()).map_err(|_| Error::invalid("the saved encryption key is damaged"))?;
                Ok(Some(b.try_into().map_err(|_| Error::invalid("the saved encryption key is damaged"))?))
            }
        }
    }
}

/// What [`connect`] found.
#[derive(Debug, PartialEq, Serialize)]
pub struct Connected {
    pub encrypted: bool,
    /// The folder's key (base64), to keep with the account.
    pub key: Option<String>,
}

/// Why [`connect`] couldn't: the folder is encrypted and needs its
/// passphrase (`NeedsPassphrase`), or that wasn't it (`WrongPassphrase`).
pub const NEEDS_PASSPHRASE: &str = "This CleanNotes folder is encrypted: enter its passphrase.";

/// Checks the account can be read, and makes the folder's key from its
/// passphrase if it's encrypted. `min_memory_kib`: see
/// [`crypto::MIN_MEMORY_KIB`].
pub async fn connect<T: Transport>(account: &Account, passphrase: Option<&str>, transport: &T, min_memory_kib: u32) -> Result<Connected> {
    let (loc, cr) = (account.location(), account.credentials());
    let client = Client::new(&loc, &cr, transport);
    // Reading the listing checks the bucket, region and access key.
    client.list(&format!("{NOTES}{}", tabs::ID_PREFIX)).await?;
    match Folder::settings(&client).await? {
        None => Ok(Connected { encrypted: false, key: None }),
        Some(s) => {
            let p = passphrase.filter(|p| !p.is_empty()).ok_or_else(|| Error::invalid(NEEDS_PASSPHRASE))?;
            let key = crypto::unlock(p, &s, min_memory_kib)?;
            Ok(Connected { encrypted: true, key: Some(B64.encode(key)) })
        }
    }
}

/// A saved tab, as the extension shows it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Tab {
    /// Its note's object (`notes/<stem>.md`) and version.
    pub stem: String,
    pub etag: String,
    pub id: String,
    /// The note's folder, from the top: `["CleanTabs", "Reading"]`.
    pub folder: Vec<String>,
    pub created: DateTime<Utc>,
    pub modified: DateTime<Utc>,
    pub deleted: Option<DateTime<Utc>>,
    pub title: String,
    pub url: String,
    pub thumbnail: Option<String>,
    /// What's been written about it in CleanNotes.
    pub text: String,
}

impl Tab {
    fn from_note(n: &StoredNote) -> Option<Tab> {
        let t = TabNote::parse(&n.data.body)?;
        Some(Tab {
            stem: n.stem.clone(),
            etag: n.etag.clone(),
            id: n.data.id.clone(),
            folder: n.data.folder.clone(),
            created: n.data.created,
            modified: n.data.modified,
            deleted: n.data.deleted,
            title: t.title,
            url: t.url,
            thumbnail: t.thumbnail,
            text: t.text,
        })
    }
}

/// Every saved tab, and the folders under `Tabs`.
#[derive(Debug, Serialize)]
pub struct Listing {
    pub tabs: Vec<Tab>,
    /// Paths from the top (`["CleanTabs", "Reading"]`), sorted.
    pub folders: Vec<Vec<String>>,
}

fn folder<'a, T: Transport>(account: &Account, loc: &'a Location, cr: &'a Credentials, transport: &'a T) -> Result<Folder<'a, T>> {
    Ok(Folder::new(Client::new(loc, cr, transport), account.key()?))
}

/// Every tab note (deleted ones too: the extension shows Recently
/// Deleted), oldest first, and the folders under `CleanTabs`. Tabs the
/// first version saved under `Tabs` are moved to `CleanTabs` first.
pub async fn list<T: Transport>(account: &Account, transport: &T, now: DateTime<Utc>) -> Result<Listing> {
    let listing = read(account, transport).await?;
    let legacy: Vec<&Tab> = listing.tabs.iter().filter(|t| t.folder.first().map(String::as_str) == Some(tabs::LEGACY_FOLDER)).collect();
    if legacy.is_empty() {
        return Ok(listing);
    }
    let mut rels: Vec<Vec<String>> = legacy.iter().map(|t| t.folder[1..].to_vec()).collect();
    rels.sort();
    rels.dedup();
    for rel in &rels {
        new_folder(account, rel, transport).await?;
    }
    let refs: Vec<Ref> = legacy.iter().map(|t| Ref { stem: t.stem.clone() }).collect();
    change(account, &refs, transport, now, |n| {
        if n.folder.first().map(String::as_str) == Some(tabs::LEGACY_FOLDER) {
            n.folder[0] = tabs::FOLDER.to_owned();
        }
    })
    .await?;
    read(account, transport).await
}

async fn read<T: Transport>(account: &Account, transport: &T) -> Result<Listing> {
    let (loc, cr) = (account.location(), account.credentials());
    let f = folder(account, &loc, &cr, transport)?;
    let mut tabs: Vec<Tab> = f.notes(tabs::ID_PREFIX).await?.iter().filter_map(Tab::from_note).collect();
    tabs.sort_by(|a, b| a.created.cmp(&b.created).then_with(|| a.id.cmp(&b.id)));
    let mut folders: Vec<Vec<String>> = f.folders().await?.into_iter().map(|f| f.path).filter(|p| p[0] == tabs::FOLDER).collect();
    for t in tabs.iter().filter(|t| t.deleted.is_none() && t.folder.first().map(String::as_str) == Some(tabs::FOLDER)) {
        for n in 1..=t.folder.len() {
            folders.push(t.folder[..n].to_vec());
        }
    }
    folders.push(vec![tabs::FOLDER.to_owned()]);
    folders.sort();
    folders.dedup();
    Ok(Listing { tabs, folders })
}

/// A tab to save.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct NewTab {
    pub url: String,
    #[serde(default)]
    pub title: String,
    /// Its tab group's title: the tab goes in a sub-folder of that name.
    #[serde(default)]
    pub group: Option<String>,
    /// A JPEG picture of the page (base64).
    #[serde(default)]
    pub thumbnail: Option<String>,
}

/// A folder's path from the top: under `Tabs`, names cleaned up.
pub fn tabs_path(rel: &[String]) -> Vec<String> {
    let mut p = vec![tabs::FOLDER.to_owned()];
    p.extend(rel.iter().map(|s| s.trim().replace('/', "-")).filter(|s| !s.is_empty()).map(|s| s.chars().take(100).collect()));
    p
}

/// Saves `new` as tab notes in `CleanTabs/<rel>` (a tab in a group in
/// `CleanTabs/<rel>/<group>`), in order. Returns them as saved.
pub async fn save<T: Transport>(account: &Account, rel: &[String], new: Vec<NewTab>, transport: &T, now: DateTime<Utc>) -> Result<Vec<Tab>> {
    let (loc, cr) = (account.location(), account.credentials());
    let f = folder(account, &loc, &cr, transport)?;
    let base = tabs_path(rel);
    let mut known = f.folders().await?;
    let mut prepared = Vec::new();
    for (i, t) in new.into_iter().enumerate() {
        let url = t.url.trim().to_owned();
        if url.is_empty() {
            continue;
        }
        let mut path = base.clone();
        if let Some(g) = t.group.as_deref().map(str::trim).filter(|g| !g.is_empty()) {
            path = tabs_path(&[&base[1..], &[g.to_owned()]].concat());
        }
        let picture = t.thumbnail.as_deref().and_then(|b| B64.decode(b).ok()).filter(|d| d.len() <= MAX_THUMBNAIL && d.starts_with(&[0xff, 0xd8]));
        let thumbnail = picture.as_ref().map(|d| notes::attachment_name(d, "jpg"));
        let body = TabNote { title: t.title.trim().to_owned(), url, thumbnail, text: String::new() }.to_markdown();
        // A millisecond apart, so they're put back in this order.
        let at = now + Duration::milliseconds(i as i64);
        let note = NoteData { id: tabs::new_id(), folder: path, body, created: at, modified: at, pinned: false, deleted: None };
        prepared.push((note, picture));
    }
    let mut paths: Vec<Vec<String>> = prepared.iter().map(|(n, _)| n.folder.clone()).collect();
    paths.dedup();
    for p in &paths {
        f.ensure_folder(p, &mut known).await?;
    }
    let mut saved = Vec::new();
    for chunk in prepared.chunks(PARALLEL) {
        let results = join_all(chunk.iter().map(|(note, picture)| {
            let f = &f;
            async move {
                // The picture first: the note mustn't show a missing one.
                if let Some(p) = picture {
                    f.put_attachment(&notes::attachment_name(p, "jpg"), p).await?;
                }
                f.create_note(note).await?.ok_or_else(|| Error::invalid("a note with that id is there already"))
            }
        }))
        .await;
        for r in results {
            saved.push(r?);
        }
    }
    f.touch().await?;
    Ok(saved.iter().filter_map(Tab::from_note).collect())
}

/// A saved tab's note: its object's stem.
#[derive(Clone, Debug, Deserialize)]
pub struct Ref {
    pub stem: String,
}

/// Changes notes with `edit`, each from the version in S3 now (written
/// with `If-Match`; if it changed meanwhile, it's read again). Notes gone,
/// or no longer tab notes, are left out.
async fn change<T: Transport>(account: &Account, refs: &[Ref], transport: &T, now: DateTime<Utc>, edit: impl Fn(&mut NoteData)) -> Result<Vec<Tab>> {
    let (loc, cr) = (account.location(), account.credentials());
    let f = folder(account, &loc, &cr, transport)?;
    let mut out = Vec::new();
    for chunk in refs.chunks(PARALLEL) {
        let results = join_all(chunk.iter().map(|r| {
            let (f, edit) = (&f, &edit);
            async move {
                let rel = format!("{NOTES}{}.md", r.stem);
                for _ in 0..4 {
                    let (mut n, etag) = match f.read(&rel).await? {
                        Some((Some(text), etag)) => match format::read(&text, &r.stem, now) {
                            format::Object::Note(n) if tabs::is_tab(&n) => (n, etag),
                            _ => return Ok(None),
                        },
                        _ => return Ok(None),
                    };
                    edit(&mut n);
                    n.modified = now.max(n.modified + Duration::milliseconds(1));
                    if let Some(stored) = f.update_note(&r.stem, &etag, &n).await? {
                        return Ok(Tab::from_note(&stored));
                    }
                    // Changed meanwhile: read it again.
                }
                Err(Error::invalid("a tab's note keeps changing; try again"))
            }
        }))
        .await;
        for r in results {
            out.extend(r?);
        }
    }
    if !out.is_empty() {
        f.touch().await?;
    }
    Ok(out)
}

/// Puts tabs in CleanNotes' Recently Deleted.
pub async fn delete<T: Transport>(account: &Account, refs: &[Ref], transport: &T, now: DateTime<Utc>) -> Result<Vec<Tab>> {
    change(account, refs, transport, now, |n| {
        n.deleted.get_or_insert(now);
    })
    .await
}

/// Brings tabs back from Recently Deleted.
pub async fn recover<T: Transport>(account: &Account, refs: &[Ref], transport: &T, now: DateTime<Utc>) -> Result<Vec<Tab>> {
    change(account, refs, transport, now, |n| n.deleted = None).await
}

/// Moves tabs to `CleanTabs/<rel>`.
pub async fn move_to<T: Transport>(account: &Account, refs: &[Ref], rel: &[String], transport: &T, now: DateTime<Utc>) -> Result<Vec<Tab>> {
    let path = tabs_path(rel);
    new_folder(account, rel, transport).await?;
    change(account, refs, transport, now, |n| n.folder = path.clone()).await
}

/// Makes the folder `CleanTabs/<rel>` (and its parents).
pub async fn new_folder<T: Transport>(account: &Account, rel: &[String], transport: &T) -> Result<()> {
    let (loc, cr) = (account.location(), account.credentials());
    let f = folder(account, &loc, &cr, transport)?;
    let mut known = f.folders().await?;
    if f.ensure_folder(&tabs_path(rel), &mut known).await? {
        f.touch().await?;
    }
    Ok(())
}

/// A saved picture of a page.
pub async fn thumbnail<T: Transport>(account: &Account, name: &str, transport: &T) -> Result<Option<Vec<u8>>> {
    let (loc, cr) = (account.location(), account.credentials());
    folder(account, &loc, &cr, transport)?.get_attachment(name).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use cleanbucket::block_on;
    use cleanbucket::fake::FakeS3;

    fn account(key: Option<String>) -> Account {
        Account {
            bucket: "b".into(),
            region: "us-east-1".into(),
            prefix: "CleanNotes".into(),
            endpoint: None,
            access_key_id: "AK".into(),
            secret_access_key: "SK".into(),
            session_token: None,
            key,
        }
    }

    fn jpeg(n: u8) -> String {
        B64.encode([0xff, 0xd8, 0xff, n])
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-11-19T21:00:00Z").unwrap().into()
    }

    #[test]
    fn save_list_move_delete_and_recover() {
        let s3 = FakeS3::new();
        let a = account(None);
        block_on(async {
            assert_eq!(connect(&a, None, &s3, 8).await.unwrap(), Connected { encrypted: false, key: None });
            let new = vec![
                NewTab { url: "https://a.example/".into(), title: "A".into(), thumbnail: Some(jpeg(1)), ..Default::default() },
                NewTab { url: "https://b.example/".into(), title: "B".into(), group: Some("Docs".into()), ..Default::default() },
                NewTab { url: "  ".into(), ..Default::default() },
                NewTab { url: "https://c.example/".into(), title: "C".into(), group: Some("Docs".into()), thumbnail: Some("not a jpeg".into()) },
            ];
            let saved = save(&a, &["Research".into()], new, &s3, now()).await.unwrap();
            assert_eq!(saved.len(), 3);
            assert_eq!(saved[0].folder, ["CleanTabs", "Research"]);
            assert_eq!(saved[1].folder, ["CleanTabs", "Research", "Docs"]);
            assert!(saved[0].thumbnail.is_some() && saved[2].thumbnail.is_none());
            assert!(saved.iter().all(|t| t.id.starts_with("tab-")));

            let l = list(&a, &s3, now()).await.unwrap();
            assert_eq!(l.tabs.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), ["A", "B", "C"], "in the order saved");
            assert_eq!(l.folders, [vec!["CleanTabs"], vec!["CleanTabs", "Research"], vec!["CleanTabs", "Research", "Docs"]]);
            let pic = thumbnail(&a, saved[0].thumbnail.as_ref().unwrap(), &s3).await.unwrap();
            assert_eq!(pic, Some(vec![0xff, 0xd8, 0xff, 1]));

            let r = |t: &Tab| Ref { stem: t.stem.clone() };
            let moved = move_to(&a, &[r(&saved[1])], &["Later".into()], &s3, now()).await.unwrap();
            assert_eq!(moved[0].folder, ["CleanTabs", "Later"]);
            // From the version in S3, not the one the caller had.
            let gone = delete(&a, &[r(&saved[1]), r(&saved[0])], &s3, now()).await.unwrap();
            assert_eq!(gone.len(), 2);
            assert!(gone.iter().all(|t| t.deleted.is_some()));
            assert_eq!(gone[0].folder, ["CleanTabs", "Later"], "the move is kept");
            let back = recover(&a, &[r(&gone[0])], &s3, now()).await.unwrap();
            assert!(back[0].deleted.is_none());
        });
        assert!(s3.objects.borrow().contains_key("CleanNotes/head"));
    }

    #[test]
    fn tabs_the_first_version_saved_under_tabs_move_to_cleantabs() {
        let s3 = FakeS3::new();
        let a = account(None);
        let body = TabNote { title: "Old".into(), url: "https://old.example/".into(), ..Default::default() }.to_markdown();
        let old = NoteData { id: "tab-old".into(), folder: vec!["Tabs".into(), "Research".into()], body, created: now(), modified: now(), pinned: false, deleted: None };
        s3.insert("CleanNotes/notes/tab-old.md", format::write(&old).into_bytes());
        // A user's own note in a Tabs folder stays where it is.
        let mine = NoteData { id: "6f1c0d3e".into(), folder: vec!["Tabs".into()], body: "# Mine\n".into(), ..old.clone() };
        s3.insert("CleanNotes/notes/6f1c0d3e.md", format::write(&mine).into_bytes());
        block_on(async {
            let l = list(&a, &s3, now()).await.unwrap();
            assert_eq!(l.tabs.len(), 1);
            assert_eq!(l.tabs[0].folder, ["CleanTabs", "Research"]);
            assert_eq!(l.folders, [vec!["CleanTabs"], vec!["CleanTabs", "Research"]]);
        });
        let objects = s3.objects.borrow();
        assert!(String::from_utf8_lossy(&objects["CleanNotes/notes/tab-old.md"].0).contains("folder: [CleanTabs, Research]"));
        assert!(String::from_utf8_lossy(&objects["CleanNotes/notes/6f1c0d3e.md"].0).contains("folder: [Tabs]"));
    }

    #[test]
    fn encrypted_folders_need_their_passphrase() {
        let s3 = FakeS3::new();
        let (settings, key) = crypto::create_with("open sesame", 64, 1).unwrap();
        s3.insert("CleanNotes/encryption.json", serde_json::to_vec(&settings).unwrap());
        let a = account(None);
        block_on(async {
            assert_eq!(connect(&a, None, &s3, 8).await.unwrap_err().to_string(), NEEDS_PASSPHRASE);
            assert_eq!(connect(&a, Some("nope"), &s3, 8).await.unwrap_err().to_string(), crypto::WRONG_KEY);
            let c = connect(&a, Some("open sesame"), &s3, 8).await.unwrap();
            assert_eq!(c.key, Some(B64.encode(key)));
            let a = account(c.key);
            let new = vec![NewTab { url: "https://secret.example/".into(), title: "Secret".into(), thumbnail: Some(jpeg(2)), ..Default::default() }];
            let saved = save(&a, &[], new, &s3, now()).await.unwrap();
            assert_eq!(saved[0].folder, ["CleanTabs"]);
            assert_eq!(list(&a, &s3, now()).await.unwrap().tabs[0].title, "Secret");
            assert!(thumbnail(&a, saved[0].thumbnail.as_ref().unwrap(), &s3).await.unwrap().is_some());
            assert!(list(&account(None), &s3, now()).await.unwrap().tabs.is_empty(), "unreadable without the key");
        });
        for (k, (v, _)) in s3.objects.borrow().iter() {
            assert!(!String::from_utf8_lossy(v).contains("secret.example"), "{k} is in clear");
        }
    }
}
