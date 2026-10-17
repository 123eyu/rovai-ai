//! Short-lived, source-scoped downloads. Source checks use Core; bounded file I/O
//! and slow network clients never hold its command queue between those checks.
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
    sync::{
        Mutex, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};
use tokio::{
    io::AsyncReadExt,
    sync::{OwnedSemaphorePermit, broadcast, mpsc, watch},
};

const ADMISSION_WINDOW: Duration = Duration::from_secs(120);
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const CHUNK: usize = 64 * 1024;
static NEXT_OPERATION: AtomicU64 = AtomicU64::new(1);

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
    completed: AtomicBool,
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

fn make_ticket_room(
    tickets: &mut HashMap<[u8; 32], Arc<Ticket>>,
    session: &Weak<Session>,
) -> Result<()> {
    loop {
        let session_full = tickets
            .values()
            .filter(|ticket| ticket.session.ptr_eq(session))
            .count()
            >= 16;
        if tickets.len() < 256 && !session_full {
            return Ok(());
        }
        // Completed tickets remain retryable until expiry or cache pressure.
        // Never evict an active transfer or consume a ticket merely for HEAD.
        let oldest = tickets
            .iter()
            .filter(|(_, ticket)| {
                ticket.completed.load(Ordering::Acquire)
                    && ticket.active.available_permits() == 1
                    && (!session_full || ticket.session.ptr_eq(session))
            })
            .min_by_key(|(_, ticket)| ticket.expires)
            .map(|(key, _)| *key)
            .context("download_ticket_capacity")?;
        tickets.remove(&oldest);
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Flow {
    Ready,
    Checking,
    Failed,
}

struct Progress {
    operation: u64,
    emitted: AtomicU64,
    settled: AtomicBool,
}
impl Progress {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            operation: NEXT_OPERATION.fetch_add(1, Ordering::Relaxed),
            emitted: AtomicU64::new(0),
            settled: AtomicBool::new(false),
        })
    }
    fn interrupted(&self, error: &anyhow::Error) {
        if self.settled.swap(true, Ordering::AcqRel) {
            return;
        }
        let stage = error
            .chain()
            .filter_map(|cause| match cause.to_string().as_str() {
                "read" => Some("read"),
                "send" => Some("send"),
                "validation" => Some("validation"),
                "authority" => Some("authority"),
                _ => None,
            })
            .last()
            .unwrap_or("response");
        // Only closed, non-sensitive fields: never the ticket, URL, source or path.
        eprintln!(
            "{}",
            json!({"event":"web.download.interrupted","operationId":self.operation,
            "stage":stage,"code":error_code(error),"bytesEmitted":self.emitted.load(Ordering::Acquire)})
        );
    }
}

async fn ready(flow: &mut watch::Receiver<Flow>) -> Result<()> {
    loop {
        let current = *flow.borrow_and_update();
        match current {
            Flow::Ready => return Ok(()),
            Flow::Failed => anyhow::bail!("download_interrupted"),
            Flow::Checking => flow.changed().await.context("core_unavailable")?,
        }
    }
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
        let permit = Arc::new(
            state
                .downloads
                .preparing
                .clone()
                .try_acquire_owned()
                .context("download_capacity")?,
        );
        let mut target = match request {
            Prepare::Source { source } => {
                resources::download_source(&state, &session, source).await?
            }
            Prepare::Preview {
                handle_id,
                expected_generation,
            } => {
                resources::download_preview(
                    &state,
                    &session,
                    &handle_id,
                    &expected_generation,
                    permit.clone(),
                )
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
        let (_, observed) = open(&target.path, permit).await?;
        state.downloads.check_size(observed)?;
        ensure!(state.sessions.is_live(&session), "session_required");
        let token = new_token()?;
        let ticket = Arc::new(Ticket {
            session: Arc::downgrade(&session),
            target,
            observed,
            expires: Instant::now() + ADMISSION_WINDOW,
            active: Arc::new(Semaphore::new(1)),
            completed: AtomicBool::new(false),
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
        make_ticket_room(&mut tickets, &ticket.session)?;
        let reply = json!({"url":format!("/api/v1/downloads/{token}"),"name":ticket.target.name,
            "byteSize":observed.byte_size(),"expiresInSeconds":ADMISSION_WINDOW.as_secs()});
        tickets.insert(digest(&token), ticket);
        Ok::<_, anyhow::Error>(Json(reply).into_response())
    }
    .await;
    result.unwrap_or_else(failure)
}

/// Keep capacity in the blocking task itself, even if its HTTP future is dropped.
async fn open(
    path: &std::path::Path,
    capacity: impl Send + 'static,
) -> Result<(std::fs::File, FileObservation)> {
    let path = path.to_owned();
    resources::blocking(capacity, move || {
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
    .await
}

/// Lease belongs to the HTTP body, including queued bytes after the reader
/// finishes. On cancellation the worker releases it even for an unpolled body.
struct Lease(Mutex<Option<Arc<Vec<OwnedSemaphorePermit>>>>);
impl Lease {
    fn release(&self) {
        self.0.lock().expect("download lease poisoned").take();
    }
    fn retain(&self) -> Result<Arc<Vec<OwnedSemaphorePermit>>> {
        self.0
            .lock()
            .expect("download lease poisoned")
            .as_ref()
            .cloned()
            .context("client_disconnected")
    }
}
struct Transfer {
    task: JoinHandle<()>,
    lease: Arc<Lease>,
    progress: Arc<Progress>,
}
impl Drop for Transfer {
    fn drop(&mut self) {
        self.task.abort();
        self.lease.release();
        self.progress
            .interrupted(&anyhow::anyhow!("client_disconnected"));
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
        let prepare = Arc::new(state.downloads.preparing.clone().try_acquire_owned().context("download_capacity")?);
        // Subscribe before reauthorization, so a deletion accepted in the gap is
        // observable even when initiated from Desktop or another Web session.
        let mut events = state.core.subscribe();
        let client = DraftClient::verified_web(&session.client_id)?;
        ticket.target.reauthorize(&state, &client).await?;
        let (file, observed) = open(&ticket.target.path, prepare.clone()).await?;
        ensure!(observed == ticket.observed, "file_changed");
        state.downloads.check_size(observed)?;
        ensure!(state.sessions.is_live(&session), "session_required");
        if drain_events(&mut events, &ticket.target.source)? {
            refresh_authority(&state, &ticket.target, &client, &mut events).await?;
            ensure!(state.sessions.is_live(&session), "session_required");
        }
        let size = observed.byte_size();
        let body = if method == Method::HEAD || size == 0 {
            if let Some(expected) = &ticket.target.expected_generation {
                if size == 0 { ensure!(*expected == format!("{:x}", Sha256::digest([])), "file_changed"); }
            }
            if method == Method::GET { ticket.completed.store(true, Ordering::Release); }
            Body::empty()
        } else {
            let permits = vec![state.downloads.active.clone().try_acquire_owned().context("download_capacity")?,
                session.downloads.clone().try_acquire_owned().context("download_capacity")?,
                ticket.active.clone().try_acquire_owned().context("download_capacity")?];
            let lease = Arc::new(Lease(Mutex::new(Some(Arc::new(permits)))));
            let worker_lease = lease.clone();
            let (tx, mut rx) = mpsc::channel::<Option<Bytes>>(1);
            let (flow, mut flow_rx) = watch::channel(Flow::Ready);
            let worker_ticket = ticket.clone();
            let progress = Progress::new();
            let worker_progress = progress.clone();
            let task = tokio::spawn(async move {
                let result = tokio::select! {
                    biased;
                    result = watch_authority(&state, &session, &worker_ticket.target, &client, events, &flow) => result.context("authority"),
                    _ = tx.closed() => Err(anyhow::anyhow!("client_disconnected")),
                    result = async {
                        pump(&state, &session, &worker_ticket, &client, file, &tx, &worker_lease).await?;
                        tokio::time::timeout(IDLE_TIMEOUT, tx.send(None)).await.context("send")?.context("client_disconnected")?;
                        tokio::time::timeout(IDLE_TIMEOUT, tx.closed()).await.context("send")?;
                        Ok::<_, anyhow::Error>(())
                    } => result,
                };
                if let Err(error) = result {
                    worker_progress.interrupted(&error);
                    flow.send_replace(Flow::Failed);
                    worker_lease.release();
                }
            });
            let transfer = Transfer { task, lease, progress: progress.clone() };
            let body_ticket = ticket.clone();
            Body::from_stream(async_stream::stream! {
                let _transfer = transfer;
                loop {
                    if ready(&mut flow_rx).await.is_err() { yield Err(std::io::Error::other("download interrupted")); break; }
                    let bytes = tokio::select! {
                        biased;
                        changed = flow_rx.changed() => {
                            if changed.is_err() { yield Err(std::io::Error::other("download interrupted")); break; }
                            continue;
                        }
                        bytes = rx.recv() => bytes,
                    };
                    if ready(&mut flow_rx).await.is_err() { yield Err(std::io::Error::other("download interrupted")); break; }
                    match bytes {
                        Some(Some(bytes)) => {
                            if progress.emitted.fetch_add(bytes.len() as u64, Ordering::AcqRel) + bytes.len() as u64 == size {
                                progress.settled.store(true, Ordering::Release);
                                body_ticket.completed.store(true, Ordering::Release);
                            }
                            yield Ok(bytes);
                        }
                        Some(None) => break,
                        None => { yield Err(std::io::Error::other("download interrupted")); break; }
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
    lease: &Lease,
) -> Result<()> {
    let witness = file.try_clone().context("read")?;
    let mut reader = tokio::fs::File::from_std(file);
    let mut digest = Sha256::new();
    let mut remaining = ticket.observed.byte_size();
    let mut tail = Vec::new();
    while remaining > 0 {
        let mut bytes = vec![0; remaining.min(CHUNK as u64) as usize];
        tokio::time::timeout(IDLE_TIMEOUT, reader.read_exact(&mut bytes))
            .await
            .context("read")?
            .context("read")?;
        if ticket.target.expected_generation.is_some() {
            digest.update(&bytes);
        }
        remaining -= bytes.len() as u64;
        // Never release the final Content-Length bytes before validation. A
        // post-completion hash error cannot make a browser reject a saved file.
        if remaining == 0 {
            tail = bytes;
        } else {
            tokio::time::timeout(IDLE_TIMEOUT, tx.send(Some(Bytes::from(bytes))))
                .await
                .context("send")?
                .context("client_disconnected")?;
        }
    }
    let permit = tokio::time::timeout(IDLE_TIMEOUT, tx.reserve())
        .await
        .context("send")?
        .context("client_disconnected")?;
    async {
        let mut extra = [0u8; 1];
        ensure!(
            tokio::time::timeout(IDLE_TIMEOUT, reader.read(&mut extra)).await?? == 0,
            "file_changed"
        );
        ensure!(
            observe_open_file(&witness)? == ticket.observed,
            "file_changed"
        );
        let (_, current) = open(&ticket.target.path, lease.retain()?)
            .await
            .context("validation")?;
        ensure!(current == ticket.observed, "file_changed");
        if let Some(expected) = &ticket.target.expected_generation {
            ensure!(
                *expected == format!("{:x}", digest.finalize()),
                "file_changed"
            );
        }
        ticket
            .target
            .reauthorize(state, client)
            .await
            .context("authority")?;
        ensure!(state.sessions.is_live(session), "session_required");
        ensure!(
            observe_open_file(&witness)? == ticket.observed,
            "file_changed"
        );
        permit.send(Some(Bytes::from(tail)));
        Ok::<_, anyhow::Error>(())
    }
    .await
    .context("validation")
}

fn check_event(event: &Value, source: &Value) -> Result<()> {
    let params = &event["params"];
    if event["method"] == "navigation.invalidated"
        && params["threadId"] == source["threadId"]
        && matches!(
            params["reason"].as_str(),
            Some("camps.delete_accepted" | "camp.deleted")
        )
    {
        anyhow::bail!("source_not_authorized");
    }
    if event["method"] == "thread.messages.changed" && params["threadId"] == source["threadId"] {
        let message = source
            .get("messageId")
            .or_else(|| source["locator"].get("messageId"));
        ensure!(
            !message.is_some_and(|message| params["unavailableMessageIds"]
                .as_array()
                .is_some_and(|ids| ids.contains(message))),
            "source_not_authorized"
        );
    }
    Ok(())
}
fn drain_events(events: &mut broadcast::Receiver<Value>, source: &Value) -> Result<bool> {
    let mut invalidated = false;
    for _ in 0..256 {
        match events.try_recv() {
            Ok(event) => {
                check_event(&event, source)?;
                invalidated |= source_event(&event, source);
            }
            Err(broadcast::error::TryRecvError::Empty) => return Ok(invalidated),
            Err(broadcast::error::TryRecvError::Lagged(_)) => invalidated = true,
            Err(broadcast::error::TryRecvError::Closed) => anyhow::bail!("core_unavailable"),
        }
    }
    // Bound synchronous draining even if unrelated producers never fall quiet.
    Ok(true)
}
fn source_event(event: &Value, source: &Value) -> bool {
    event["params"]["threadId"] == source["threadId"]
        && matches!(
            event["method"].as_str(),
            Some("single_chat.changed" | "thread.messages.changed" | "navigation.invalidated")
        )
}
async fn refresh_authority(
    state: &WebState,
    target: &resources::DownloadTarget,
    client: &DraftClient,
    events: &mut broadcast::Receiver<Value>,
) -> Result<()> {
    refresh_events(&target.source, events, || target.reauthorize(state, client)).await
}

async fn refresh_events<F, Fut>(
    source: &Value,
    events: &mut broadcast::Receiver<Value>,
    mut authorize: F,
) -> Result<()>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<()>>,
{
    tokio::time::timeout(IDLE_TIMEOUT, async {
        loop {
            // Start a fresh observation window before the authoritative read.
            // A new gap or relevant change during that read needs another pass.
            *events = events.resubscribe();
            authorize().await?;
            if !drain_events(events, source)? {
                return Ok::<_, anyhow::Error>(());
            }
        }
    })
    .await?
}
async fn watch_authority(
    state: &WebState,
    session: &Arc<Session>,
    target: &resources::DownloadTarget,
    client: &DraftClient,
    mut events: broadcast::Receiver<Value>,
    flow: &watch::Sender<Flow>,
) -> Result<()> {
    let mut revoked = session.revoked.subscribe();
    let mut expiry = session.expires_at.subscribe();
    let mut startup = state.core.startup();
    let source = async {
        let mut fallback = tokio::time::interval(Duration::from_secs(2));
        fallback.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        fallback.tick().await;
        loop {
            tokio::select! {
                event = events.recv() => match event {
                    Ok(event) => {
                        check_event(&event, &target.source)?;
                        if !source_event(&event, &target.source) { continue; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {},
                    Err(broadcast::error::RecvError::Closed) => anyhow::bail!("core_unavailable"),
                },
                // Paths and legacy source lifecycles do not all emit a scoped
                // invalidation. Keep the existing fallback until they do; only
                // this one source-check future runs, with queued events coalesced.
                _ = fallback.tick() => {},
            }
            flow.send_replace(Flow::Checking);
            // Consume explicit revocations before discarding an observation gap.
            drain_events(&mut events, &target.source)?;
            refresh_authority(state, target, client, &mut events).await?;
            flow.send_replace(Flow::Ready);
        }
        #[allow(unreachable_code)]
        Ok::<(), anyhow::Error>(())
    };
    tokio::pin!(source);
    loop {
        ensure!(state.sessions.is_live(session), "session_required");
        ensure!(startup.borrow()["status"] == "ready", "core_unavailable");
        tokio::select! {
            biased;
            changed = revoked.changed() => { changed.context("session_required")?; ensure!(!*revoked.borrow(), "session_required"); }
            changed = expiry.changed() => { changed.context("session_required")?; }
            changed = startup.changed() => { changed.context("core_unavailable")?; }
            _ = tokio::time::sleep(Duration::from_millis(session.expiry().saturating_sub(state.sessions.now()))) => {}
            result = &mut source => return result,
        }
    }
}
fn error_code(error_value: &anyhow::Error) -> &'static str {
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
        "download_ticket_capacity",
        "client_disconnected",
        "core_unavailable",
    ];
    error_value
        .chain()
        .find_map(|error| {
            known
                .iter()
                .copied()
                .find(|code| error.to_string() == *code)
        })
        .unwrap_or_else(|| {
            if error_value
                .downcast_ref::<tokio::time::error::Elapsed>()
                .is_some()
            {
                "download_timeout"
            } else if error_value.downcast_ref::<std::io::Error>().is_some() {
                "read_failed"
            } else {
                "download_unavailable"
            }
        })
}
fn failure(error_value: anyhow::Error) -> Response {
    let code = error_code(&error_value);
    let status = match code {
        "session_required" => StatusCode::UNAUTHORIZED,
        "source_not_authorized" => StatusCode::FORBIDDEN,
        "file_not_found" => StatusCode::NOT_FOUND,
        "download_expired" => StatusCode::GONE,
        "file_changed" => StatusCode::CONFLICT,
        "download_too_large" => StatusCode::PAYLOAD_TOO_LARGE,
        "download_capacity" | "download_ticket_capacity" => StatusCode::TOO_MANY_REQUESTS,
        "core_unavailable" => StatusCode::SERVICE_UNAVAILABLE,
        "download_timeout" => StatusCode::GATEWAY_TIMEOUT,
        _ => StatusCode::BAD_REQUEST,
    };
    super::error(status, code)
}

#[cfg(test)]
mod tests {
    use super::*;
    // Owns event-gap recovery and the byte-release boundary with no Core/DB
    // fixture. The HTTP owner covers actual editor/source and Session revocation.
    #[tokio::test]
    async fn event_gaps_revalidate_before_releasing_bytes_and_keep_explicit_revocations() {
        use std::{future::Future, task::Poll};
        let source = json!({"threadId":"files","messageId":"message"});
        let unrelated = json!({"method":"thread.messages.changed","params":{"threadId":"other"}});
        let (events, mut receiver) = broadcast::channel(2);
        for _ in 0..4 {
            events.send(unrelated.clone()).unwrap();
        }
        assert!(
            drain_events(&mut receiver, &source).unwrap(),
            "a gap invalidates the observation, not the source permission"
        );

        let (flow, mut flow_rx) = watch::channel(Flow::Checking);
        let pending = ready(&mut flow_rx);
        tokio::pin!(pending);
        assert!(matches!(
            std::future::poll_fn(|cx| Poll::Ready(pending.as_mut().poll(cx))).await,
            Poll::Pending
        ));
        let calls = AtomicU64::new(0);
        refresh_events(&source, &mut receiver, || {
            if calls.fetch_add(1, Ordering::Relaxed) == 0 {
                // A second gap during reauthorization needs a fresh read; one
                // successful answer cannot cover events it has not observed.
                for _ in 0..4 {
                    events.send(unrelated.clone()).unwrap();
                }
            }
            std::future::ready(Ok(()))
        })
        .await
        .unwrap();
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        flow.send_replace(Flow::Ready);
        pending.await.unwrap();

        let denied = refresh_events(&source, &mut receiver, || {
            std::future::ready(Err(anyhow::anyhow!("source_not_authorized")))
        })
        .await
        .unwrap_err();
        assert_eq!(error_code(&denied), "source_not_authorized");
        let deleted = json!({"method":"navigation.invalidated","params":{"threadId":"files","reason":"camps.delete_accepted"}});
        let revoked = refresh_events(&source, &mut receiver, || {
            events.send(deleted.clone()).unwrap();
            std::future::ready(Ok(()))
        })
        .await
        .unwrap_err();
        assert_eq!(error_code(&revoked), "source_not_authorized");
        drop(events);
        assert_eq!(
            error_code(&drain_events(&mut receiver, &source).unwrap_err()),
            "core_unavailable"
        );
    }
}
