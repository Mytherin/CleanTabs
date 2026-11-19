//! CleanTabs' core for the Chrome extension, as WebAssembly: tabs saved as
//! notes in a CleanNotes account's S3 folder, under `CleanTabs/`. The folder's
//! format, its encryption and tab notes are CleanNotes' own (the
//! `cleanbucket` crate's `notes` module); this is the extension's view of
//! them ([`ops`]) and its JavaScript interface.
//!
//! Values cross as plain JS objects (serde); errors as `Error`s whose
//! message is fit to show, with `name` set to `NeedsPassphrase` or
//! `WrongPassphrase` when that's what it is.
//!
//! Every call takes the account (see [`ops::Account`]) and a `fetch`-like
//! function: `({method, url, headers: [[k, v]], body: Uint8Array}) =>
//! Promise<{status, headers: [[k, v]], body: Uint8Array}>`, which must not
//! follow redirects.

pub mod ops;

use cleanbucket::notes::crypto;
use cleanbucket::s3::{HttpRequest, HttpResponse, Transport};
use cleanbucket::Error;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

fn to_js<T: Serialize + ?Sized>(v: &T) -> Result<JsValue, JsValue> {
    v.serialize(&serde_wasm_bindgen::Serializer::json_compatible()).map_err(|e| JsError::new(&e.to_string()).into())
}

fn from_js<T: DeserializeOwned>(v: JsValue) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(v).map_err(|e| JsError::new(&format!("bad argument: {e}")).into())
}

fn err(e: Error) -> JsValue {
    let message = e.to_string();
    let js = js_sys::Error::new(&message);
    if message == ops::NEEDS_PASSPHRASE {
        js.set_name("NeedsPassphrase");
    } else if message == crypto::WRONG_KEY {
        js.set_name("WrongPassphrase");
    }
    js.into()
}

/// A transport over a JS function.
struct JsTransport(js_sys::Function);

#[derive(Serialize)]
struct JsRequest<'a> {
    method: &'a str,
    url: &'a str,
    headers: &'a [(String, String)],
}

#[derive(Deserialize)]
struct JsResponse {
    status: u16,
    headers: Vec<(String, String)>,
}

fn js_message(v: JsValue) -> String {
    v.dyn_ref::<js_sys::Error>().map(|e| String::from(e.message())).or_else(|| v.as_string()).unwrap_or_else(|| "network error".into())
}

impl Transport for JsTransport {
    async fn send(&self, req: HttpRequest) -> Result<HttpResponse, String> {
        let obj = to_js(&JsRequest { method: &req.method, url: &req.url, headers: &req.headers }).map_err(|_| "request".to_string())?;
        js_sys::Reflect::set(&obj, &"body".into(), &js_sys::Uint8Array::from(req.body.as_slice()).into()).map_err(|_| "request body".to_string())?;
        let promise = self.0.call1(&JsValue::NULL, &obj).map_err(js_message)?;
        let resp = JsFuture::from(js_sys::Promise::from(promise)).await.map_err(js_message)?;
        let body = js_sys::Reflect::get(&resp, &"body".into()).map_err(js_message)?;
        let body = if body.is_undefined() || body.is_null() { Vec::new() } else { js_sys::Uint8Array::new(&body).to_vec() };
        let r: JsResponse = serde_wasm_bindgen::from_value(resp).map_err(|e| e.to_string())?;
        Ok(HttpResponse { status: r.status, headers: r.headers, body })
    }
}

type JsResult = Result<JsValue, JsValue>;

/// Checks the account (`{bucket, region, prefix, endpoint?,
/// access_key_id, secret_access_key}`), and makes the folder's key if it's
/// encrypted. Returns `{encrypted, key}`; keep `key` with the account.
#[wasm_bindgen]
pub async fn connect(account: JsValue, passphrase: Option<String>, fetch: js_sys::Function) -> JsResult {
    let account: ops::Account = from_js(account)?;
    let r = ops::connect(&account, passphrase.as_deref(), &JsTransport(fetch), crypto::MIN_MEMORY_KIB).await.map_err(err)?;
    to_js(&r)
}

/// `{tabs, folders}`: every saved tab (deleted ones too) and the folders
/// under `CleanTabs` (moving tabs the first version saved under `Tabs`).
#[wasm_bindgen]
pub async fn list(account: JsValue, fetch: js_sys::Function) -> JsResult {
    let account: ops::Account = from_js(account)?;
    to_js(&ops::list(&account, &JsTransport(fetch), chrono::Utc::now()).await.map_err(err)?)
}

/// Saves tabs (`[{url, title, group?, thumbnail?}]`) in `CleanTabs/<folder…>`.
/// Returns them as saved.
#[wasm_bindgen]
pub async fn save(account: JsValue, folder: Vec<String>, tabs: JsValue, fetch: js_sys::Function) -> JsResult {
    let account: ops::Account = from_js(account)?;
    let tabs: Vec<ops::NewTab> = from_js(tabs)?;
    to_js(&ops::save(&account, &folder, tabs, &JsTransport(fetch), chrono::Utc::now()).await.map_err(err)?)
}

/// Puts tabs (`[{stem}]`) in Recently Deleted. Returns them as changed.
#[wasm_bindgen]
pub async fn delete_tabs(account: JsValue, refs: JsValue, fetch: js_sys::Function) -> JsResult {
    let account: ops::Account = from_js(account)?;
    let refs: Vec<ops::Ref> = from_js(refs)?;
    to_js(&ops::delete(&account, &refs, &JsTransport(fetch), chrono::Utc::now()).await.map_err(err)?)
}

/// Brings tabs (`[{stem}]`) back from Recently Deleted.
#[wasm_bindgen]
pub async fn recover(account: JsValue, refs: JsValue, fetch: js_sys::Function) -> JsResult {
    let account: ops::Account = from_js(account)?;
    let refs: Vec<ops::Ref> = from_js(refs)?;
    to_js(&ops::recover(&account, &refs, &JsTransport(fetch), chrono::Utc::now()).await.map_err(err)?)
}

/// Moves tabs (`[{stem}]`) to `CleanTabs/<folder…>`.
#[wasm_bindgen]
pub async fn move_to(account: JsValue, refs: JsValue, folder: Vec<String>, fetch: js_sys::Function) -> JsResult {
    let account: ops::Account = from_js(account)?;
    let refs: Vec<ops::Ref> = from_js(refs)?;
    to_js(&ops::move_to(&account, &refs, &folder, &JsTransport(fetch), chrono::Utc::now()).await.map_err(err)?)
}

/// Makes the folder `CleanTabs/<folder…>`.
#[wasm_bindgen]
pub async fn new_folder(account: JsValue, folder: Vec<String>, fetch: js_sys::Function) -> Result<(), JsValue> {
    let account: ops::Account = from_js(account)?;
    ops::new_folder(&account, &folder, &JsTransport(fetch)).await.map_err(err)
}

/// A saved picture of a page (JPEG bytes), or `undefined`.
#[wasm_bindgen]
pub async fn thumbnail(account: JsValue, name: String, fetch: js_sys::Function) -> Result<Option<js_sys::Uint8Array>, JsValue> {
    let account: ops::Account = from_js(account)?;
    let data = ops::thumbnail(&account, &name, &JsTransport(fetch)).await.map_err(err)?;
    Ok(data.map(|d| js_sys::Uint8Array::from(d.as_slice())))
}
