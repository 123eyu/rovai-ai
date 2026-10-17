//! Short-lived, source-scoped download capabilities. Only admission uses Core's
//! command queue; bounded file I/O and slow network clients never occupy it.
use super::*;
use axum::{body::Bytes, http::Method};
use rovai_core::{
    draft_client::DraftClient,
    local_attachment_snapshot::{
        FileObservation, observe_open_file, open_resolved_file_without_following,
    },
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{Mutex, Weak},
    time::Instant,
};
use tokio::{
    io::AsyncReadExt,
    sync::{OwnedSemaphorePermit, broadcast, mpsc, watch},
};

const ADMISSION_WINDOW: Duration = Duration::from_secs(120);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const CHUNK: usize = 64 * 1024;

pub(super) struct Downloads {
    tickets: Mutex<HashMap<[u8; 32], Arc<Ticket>>>,
    active: Arc<Semaphore>,
    preparing: Arc<Semaphore>,
    max_bytes: Option<u64>,
}
struct Ticket {
    session: Weak<Session>,
    target: resources::DownloadTarget,
    observed: FileObservation,
    expires: Instant,
    active: Arc<Semaphore>,
}
impl Downloads {
    pub fn new() -> Result<Self> {
        let max_bytes = std::env::var("ROVAI_WEB_DOWNLOAD_MAX_BYTES")
            .ok()
            .map(|value| {
                value
                    .parse::<u64>()
                    .context("ROVAI_WEB_DOWNLOAD_MAX_BYTES must be an unsigned byte count")
            })
            .transpose()?;
        Ok(Self {
            tickets: Mutex::new(HashMap::new()),
            active: Arc::new(Semaphore::new(8)),
            preparing: Arc::new(Semaphore::new(4)),
            max_bytes,
        })
    }
    fn lookup(&self, token: &str) -> Result<Arc<Ticket>> {
        ensure!(
            token.len() == 64 && token.bytes().all(|b| b.is_ascii_hexdigit()),
            "download_expired"
        );
        self.tickets
            .lock()
            .expect("download registry poisoned")
            .get(&digest(token))
            .filter(|ticket| ticket.expires > Instant::now())
            .cloned()
            .context("download_expired")
    }
    fn check_size(&self, observation: FileObservation) -> Result<()> {
        ensure!(
            self.max_bytes
                .is_none_or(|max| observation.byte_size() <= max),
            "download_too_large"
        );
        Ok(())
    }
}
pub(super) fn capabilities(state: &WebState) -> Value {
    json!({"uploadMaxBytes":uploads::MAX_BYTES,"nativeDownload":true,
        "downloadMaxBytes":state.downloads.max_bytes,"downloadAdmissionSeconds":ADMISSION_WINDOW.as_secs()})
}
fn digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub(super) enum Prepare {
    Source {
        source: Value,
    },
    Preview {
        #[serde(rename = "handleId")]
        handle_id: String,
        #[serde(rename = "expectedGeneration")]
        expected_generation: String,
    },
}
pub(super) async fn prepare(
    State(state): State<WebState>,
    Extension(session): Extension<Arc<Session>>,
    Json(request): Json<Prepare>,
) -> Response {
    let result = async {
        let _permit = state
            .downloads
            .preparing
            .clone()
            .try_acquire_owned()
            .context("download_capacity")?;
        let mut target = match request {
            Prepare::Source { source } => {
                resources::download_source(&state, &session, source).await?
            }
            Prepare::Preview {
                handle_id,
                expected_generation,
            } => {
                resources::download_preview(&state, &session, &handle_id, &expected_generation)
                    .await?
            }
        };
        target.name = target
            .name
            .chars()
            .map(|c| {
                if c.is_control() || matches!(c, '/' | '\\') {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        if target.name.is_empty() || matches!(target.name.as_str(), "." | "..") {
            target.name = "attachment".to_owned();
        }
        let (_, observed) = open(&target.path).await?;
        state.downloads.check_size(observed)?;
        ensure!(state.sessions.is_live(&session), "session_required");
        let token = new_token()?;
        let ticket = Arc::new(Ticket {
            session: Arc::downgrade(&session),
            target,
            observed,
            expires: Instant::now() + ADMISSION_WINDOW,
            active: Arc::new(Semaphore::new(1)),
        });
        let mut tickets = state
            .downloads
            .tickets
            .lock()
            .expect("download registry poisoned");
        tickets.retain(|_, ticket| {
            ticket.expires > Instant::now()
                && ticket
                    .session
                    .upgrade()
                    .is_some_and(|session| state.sessions.is_live(&session))
        });
        ensure!(
            tickets.len() < 256
                && tickets
                    .values()
                    .filter(|t| t.session.ptr_eq(&ticket.session))
                    .count()
                    < 16,
            "download_capacity"
        );
        let reply = json!({"url":format!("/api/v1/downloads/{token}"),"name":ticket.target.name,
            "byteSize":observed.byte_size(),"expiresInSeconds":ADMISSION_WINDOW.as_secs()});
        tickets.insert(digest(&token), ticket);
        Ok::<_, anyhow::Error>(Json(reply).into_response())
    }
    .await;
    result.unwrap_or_else(failure)
}

async fn open(path: &std::path::Path) -> Result<(std::fs::File, FileObservation)> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        let file = open_resolved_file_without_following(&path).map_err(|error| {
            let code = if error.to_string() == "resolved file is not regular" {
                "not_regular_file"
            } else {
                match error
                    .downcast_ref::<std::io::Error>()
                    .map(std::io::Error::kind)
                {
                    Some(std::io::ErrorKind::NotFound) => "file_not_found",
                    Some(std::io::ErrorKind::PermissionDenied) => "file_unreadable",
                    _ => "download_unavailable",
                }
            };
            error.context(code)
        })?;
        let observed = observe_open_file(&file).context("not_regular_file")?;
        Ok((file, observed))
    })
    .await?
}

/// Lease belongs to the HTTP body, including queued bytes after the reader
/// finishes. On cancellation the worker releases it even for an unpolled body.
struct Lease(Mutex<Option<Vec<OwnedSemaphorePermit>>>);
impl Lease {
    fn release(&self) {
        self.0.lock().expect("download lease poisoned").take();
    }
}
struct Transfer {
    task: JoinHandle<()>,
    lease: Arc<Lease>,
}
impl Drop for Transfer {
    fn drop(&mut self) {
        self.task.abort();
        self.lease.release();
    }
}

pub(super) async fn file(
    State(state): State<WebState>,
    Path(token): Path<String>,
    method: Method,
) -> Response {
    let result = async {
        let ticket = state.downloads.lookup(&token)?;
        let session = ticket.session.upgrade().context("session_required")?;
        ensure!(state.sessions.is_live(&session), "session_required");
        let _prepare = state.downloads.preparing.clone().try_acquire_owned().context("download_capacity")?;
        // Subscribe before reauthorization, so a deletion accepted in the gap is
        // observable even when initiated from Desktop or another Web session.
        let mut events = state.core.subscribe();
        let client = DraftClient::verified_web(&session.client_id)?;
        ticket.target.reauthorize(&state, &client).await?;
        let (file, observed) = open(&ticket.target.path).await?;
        ensure!(observed == ticket.observed, "file_changed");
        state.downloads.check_size(observed)?;
        ensure!(state.sessions.is_live(&session), "session_required");
        drain_events(&mut events, &ticket.target)?;
        let size = observed.byte_size();
        let body = if method == Method::HEAD || size == 0 {
            if let Some(expected) = &ticket.target.expected_generation {
                if size == 0 { ensure!(*expected == format!("{:x}", Sha256::digest([])), "file_changed"); }
            }
            Body::empty()
        } else {
            let permits = vec![state.downloads.active.clone().try_acquire_owned().context("download_capacity")?,
                session.downloads.clone().try_acquire_owned().context("download_capacity")?,
                ticket.active.clone().try_acquire_owned().context("download_capacity")?];
            let lease = Arc::new(Lease(Mutex::new(Some(permits))));
            let worker_lease = lease.clone();
            let (tx, mut rx) = mpsc::channel::<Option<Bytes>>(1);
            let (failed, mut failure_rx) = watch::channel(false);
            let worker_ticket = ticket.clone();
            let task = tokio::spawn(async move {
                let result = tokio::select! {
                    biased;
                    result = watch_authority(&state, &session, &worker_ticket.target, &client, events) => result,
                    _ = tx.closed() => Err(anyhow::anyhow!("client_disconnected")),
                    result = async {
                        pump(&state, &session, &worker_ticket, &client, file, &tx).await?;
                        tokio::time::timeout(IDLE_TIMEOUT, tx.send(None)).await??;
                        tokio::time::timeout(IDLE_TIMEOUT, tx.closed()).await?;
                        Ok::<_, anyhow::Error>(())
                    } => result,
                };
                if result.is_err() {
                    failed.send_replace(true);
                    worker_lease.release();
                }
            });
            let transfer = Transfer { task, lease };
            Body::from_stream(async_stream::stream! {
                let _transfer = transfer;
                loop {
                    if *failure_rx.borrow() { yield Err(std::io::Error::other("download interrupted")); break; }
                    tokio::select! {
                        biased;
                        changed = failure_rx.changed() => {
                            if *failure_rx.borrow() { yield Err(std::io::Error::other("download interrupted")); break; }
                            if changed.is_err() {
                                while let Some(Some(bytes)) = rx.recv().await { yield Ok(bytes); }
                                break;
                            }
                        }
                        bytes = rx.recv() => match bytes { Some(Some(bytes)) => yield Ok(bytes), _ => break },
                    }
                }
            })
        };
        Ok::<_, anyhow::Error>(Response::builder().status(StatusCode::OK)
            .header(header::CONTENT_TYPE, "application/octet-stream")
            .header(header::CONTENT_DISPOSITION, resources::disposition(&ticket.target.name))
            .header(header::CONTENT_LENGTH, size)
            .header(header::ACCEPT_RANGES, "none")
            .header("x-accel-buffering", "no")
            .body(body)?)
    }.await;
    result.unwrap_or_else(failure)
}

async fn pump(
    state: &WebState,
    session: &Arc<Session>,
    ticket: &Ticket,
    client: &DraftClient,
    file: std::fs::File,
    tx: &mpsc::Sender<Option<Bytes>>,
) -> Result<()> {
    let witness = file.try_clone()?;
    let mut reader = tokio::fs::File::from_std(file);
    let mut digest = Sha256::new();
    let mut remaining = ticket.observed.byte_size();
    let mut tail = Vec::new();
    while remaining > 0 {
        let mut bytes = vec![0; remaining.min(CHUNK as u64) as usize];
        tokio::time::timeout(IDLE_TIMEOUT, reader.read_exact(&mut bytes)).await??;
        if ticket.target.expected_generation.is_some() {
            digest.update(&bytes);
        }
        remaining -= bytes.len() as u64;
        // Never release the final Content-Length bytes before validation. A
        // post-completion hash error cannot make a browser reject a saved file.
        if remaining == 0 {
            tail = bytes;
        } else {
            tokio::time::timeout(IDLE_TIMEOUT, tx.send(Some(Bytes::from(bytes)))).await??;
        }
    }
    let permit = tokio::time::timeout(IDLE_TIMEOUT, tx.reserve()).await??;
    let mut extra = [0u8; 1];
    ensure!(
        tokio::time::timeout(IDLE_TIMEOUT, reader.read(&mut extra)).await?? == 0,
        "file_changed"
    );
    ensure!(
        observe_open_file(&witness)? == ticket.observed,
        "file_changed"
    );
    let (_, current) = open(&ticket.target.path).await?;
    ensure!(current == ticket.observed, "file_changed");
    if let Some(expected) = &ticket.target.expected_generation {
        ensure!(
            *expected == format!("{:x}", digest.finalize()),
            "file_changed"
        );
    }
    ticket.target.reauthorize(state, client).await?;
    ensure!(state.sessions.is_live(session), "session_required");
    ensure!(
        observe_open_file(&witness)? == ticket.observed,
        "file_changed"
    );
    permit.send(Some(Bytes::from(tail)));
    Ok(())
}

fn check_event(event: &Value, target: &resources::DownloadTarget) -> Result<()> {
    let params = &event["params"];
    if event["method"] == "navigation.invalidated"
        && params["threadId"] == target.source["threadId"]
        && matches!(
            params["reason"].as_str(),
            Some("camps.delete_accepted" | "camp.deleted")
        )
    {
        anyhow::bail!("source_not_authorized");
    }
    if event["method"] == "thread.messages.changed"
        && params["threadId"] == target.source["threadId"]
    {
        let message = target
            .source
            .get("messageId")
            .or_else(|| target.source["locator"].get("messageId"));
        ensure!(
            !message.is_some_and(|message| params["unavailableMessageIds"]
                .as_array()
                .is_some_and(|ids| ids.contains(message))),
            "source_not_authorized"
        );
    }
    Ok(())
}
fn drain_events(
    events: &mut broadcast::Receiver<Value>,
    target: &resources::DownloadTarget,
) -> Result<()> {
    loop {
        match events.try_recv() {
            Ok(event) => check_event(&event, target)?,
            Err(broadcast::error::TryRecvError::Empty) => return Ok(()),
            Err(_) => anyhow::bail!("source_not_authorized"),
        }
    }
}
async fn watch_authority(
    state: &WebState,
    session: &Arc<Session>,
    target: &resources::DownloadTarget,
    client: &DraftClient,
    mut events: broadcast::Receiver<Value>,
) -> Result<()> {
    let mut revoked = session.revoked.subscribe();
    let mut expiry = session.expires_at.subscribe();
    let mut startup = state.core.startup();
    let invalidated = tokio::sync::Notify::new();
    let recheck = async {
        loop {
            tokio::select! { _ = tokio::time::sleep(Duration::from_secs(2)) => {}, _ = invalidated.notified() => {} }
            tokio::time::timeout(IDLE_TIMEOUT, target.reauthorize(state, client)).await??;
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    };
    tokio::pin!(recheck);
    loop {
        ensure!(state.sessions.is_live(session), "session_required");
        ensure!(startup.borrow()["status"] == "ready", "core_unavailable");
        tokio::select! {
            biased;
            changed = revoked.changed() => { changed.context("session_required")?; ensure!(!*revoked.borrow(), "session_required"); }
            changed = expiry.changed() => { changed.context("session_required")?; }
            changed = startup.changed() => { changed.context("core_unavailable")?; }
            event = events.recv() => {
                let event = event.context("source_not_authorized")?;
                check_event(&event, target)?;
                if event["params"]["threadId"] == target.source["threadId"] && matches!(event["method"].as_str(), Some("single_chat.changed" | "thread.messages.changed" | "navigation.invalidated")) { invalidated.notify_one(); }
            }
            _ = tokio::time::sleep(Duration::from_millis(session.expiry().saturating_sub(state.sessions.now()))) => {}
            result = &mut recheck => return result,
        }
    }
}
fn failure(error_value: anyhow::Error) -> Response {
    let known = [
        "session_required",
        "source_not_authorized",
        "file_not_found",
        "not_regular_file",
        "file_changed",
        "file_unreadable",
        "download_too_large",
        "download_expired",
        "download_capacity",
    ];
    let code = error_value
        .chain()
        .find_map(|error| {
            known
                .iter()
                .copied()
                .find(|code| error.to_string() == *code)
        })
        .unwrap_or("download_unavailable");
    let status = match code {
        "session_required" => StatusCode::UNAUTHORIZED,
        "source_not_authorized" => StatusCode::FORBIDDEN,
        "file_not_found" => StatusCode::NOT_FOUND,
        "download_expired" => StatusCode::GONE,
        "file_changed" => StatusCode::CONFLICT,
        "download_too_large" => StatusCode::PAYLOAD_TOO_LARGE,
        "download_capacity" => StatusCode::TOO_MANY_REQUESTS,
        _ => StatusCode::BAD_REQUEST,
    };
    super::error(status, code)
}
