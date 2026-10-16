//! Host temporary-file ingress into client-scoped source references. There is
//! no new asset lifetime: after binding, Core never deletes the source file.
use crate::{
    command::*, db::Database, draft_client::DraftClient,
    local_attachment_source::LocalAttachmentSourceRef,
};
use anyhow::{Result, ensure};
use rusqlite::{OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UploadIntent {
    #[serde(default, skip_serializing_if = "UploadTarget::is_camp")]
    pub target: UploadTarget,
    pub command_id: String,
    #[serde(rename = "threadId", alias = "campId")]
    pub camp_id: String,
    pub expected_revision: i64,
    pub display_name: String,
    pub byte_size: u64,
    pub sha256: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum UploadTarget {
    #[default]
    Camp,
    SingleChat {
        #[serde(rename = "conversationId")]
        conversation_id: String,
    },
    SingleChatPending {
        #[serde(rename = "conversationId")]
        conversation_id: String,
        #[serde(rename = "pendingInputId")]
        pending_input_id: String,
        #[serde(rename = "editToken")]
        edit_token: String,
    },
}
impl UploadTarget {
    fn is_camp(&self) -> bool {
        matches!(self, Self::Camp)
    }
}

pub fn snapshot(
    database: &Database,
    _data_dir: &std::path::Path,
    client: &DraftClient,
    intent: &UploadIntent,
) -> Result<serde_json::Value> {
    match &intent.target {
        UploadTarget::Camp => {
            let recorded = reconcile(database, client, intent.clone())?
                .ok_or_else(|| anyhow::anyhow!("upload receipt is missing"))?;
            Ok(recorded.result.payload["source"].clone())
        }
        UploadTarget::SingleChat { conversation_id }
        | UploadTarget::SingleChatPending {
            conversation_id, ..
        } => {
            let snapshot = crate::single_chat::SingleChatService::for_client(client.clone())
                .snapshot(database, conversation_id)?;
            ensure!(
                snapshot
                    .as_ref()
                    .is_some_and(|view| view.conversation.camp_id == intent.camp_id),
                "single_chat.camp_mismatch"
            );
            Ok(serde_json::to_value(snapshot)?)
        }
    }
}

#[derive(Serialize)]
pub struct BindUpload {
    client: DraftClient,
    intent: UploadIntent,
}
impl sealed::Sealed for BindUpload {}
impl DomainCommand for BindUpload {
    const TYPE: &'static str = "camp.source_attachment.upload.bind";
    fn draft_client(&self) -> Option<&DraftClient> {
        Some(&self.client)
    }
}

fn envelope(client: &DraftClient, intent: UploadIntent) -> Result<CommandEnvelope<BindUpload>> {
    ensure!(
        !client.is_desktop(),
        "upload requires a verified Web editor"
    );
    crate::camp_id::ThreadId::parse(&intent.camp_id)?;
    uuid::Uuid::parse_str(&intent.command_id)?;
    ensure!(
        intent.sha256.len() == 64 && intent.sha256.bytes().all(|byte| byte.is_ascii_hexdigit()),
        "invalid upload digest"
    );
    Ok(CommandEnvelope {
        command_id: intent.command_id.clone(),
        actor: ActorRef::User {
            user_id: crate::current_user::CURRENT_USER_ID.into(),
        },
        camp_id: Some(intent.camp_id.clone()),
        expected_versions: Vec::new(),
        execution_epoch: None,
        payload: BindUpload {
            client: client.clone(),
            intent,
        },
    })
}

pub fn reconcile(
    database: &Database,
    client: &DraftClient,
    intent: UploadIntent,
) -> Result<Option<CommandExecution>> {
    DomainCommandGateway.replay_if_recorded(database, &envelope(client, intent)?)
}

/// The upload receipt owns a Web Composer source after public drafts moved to
/// the client. A path supplied by the browser is never an authorization source.
pub fn load_composer_source(
    database: &Database,
    client: &DraftClient,
    camp_id: &str,
    attachment_id: &str,
) -> Result<Option<LocalAttachmentSourceRef>> {
    ensure!(
        !client.is_desktop(),
        "upload requires a verified Web editor"
    );
    crate::camp_id::ThreadId::parse(camp_id)?;
    uuid::Uuid::parse_str(attachment_id)?;
    let source: Option<String> = database
        .connection()
        .query_row(
            r#"
        SELECT json_extract(receipt.result_payload_json, '$.source')
        FROM event_log AS receipt
        JOIN camp ON camp.id = receipt.camp_id AND camp.deletion_operation_id IS NULL
        WHERE receipt.event_type = 'command.result'
          AND receipt.command_id = ?1 AND receipt.camp_id = ?2
          AND receipt.command_type = 'camp.source_attachment.upload.bind'
          AND receipt.command_client_id = ?3
          AND receipt.actor_type = 'user' AND receipt.actor_id = ?4
          AND receipt.result_status = 'applied'
          AND receipt.result_code = 'attachment.upload_bound'
          AND json_type(receipt.result_payload_json, '$.source') = 'object'
        "#,
            params![
                attachment_id,
                camp_id,
                client.id(),
                crate::current_user::CURRENT_USER_ID
            ],
            |row| row.get(0),
        )
        .optional()?;
    source
        .map(|json| {
            let source: LocalAttachmentSourceRef = serde_json::from_str(&json)?;
            ensure!(source.id == attachment_id, "upload reference changed");
            Ok(source)
        })
        .transpose()
}

pub fn composer_source_view(source: &LocalAttachmentSourceRef) -> Result<serde_json::Value> {
    use crate::local_attachment_source::{
        LocalAttachmentAvailability, LocalAttachmentFailureCode, validate_source_attachment,
    };
    let availability = match validate_source_attachment(source) {
        Ok(()) => LocalAttachmentAvailability::Available,
        Err(error) => match error.code() {
            LocalAttachmentFailureCode::Missing => LocalAttachmentAvailability::Missing,
            LocalAttachmentFailureCode::Unreadable => LocalAttachmentAvailability::Unreadable,
            LocalAttachmentFailureCode::KindChanged => LocalAttachmentAvailability::KindChanged,
        },
    };
    let mut view = serde_json::to_value(source.view(availability))?;
    if availability == LocalAttachmentAvailability::Available {
        view["sourcePath"] = json!(source.source_path);
        view["byteSize"] = json!(std::fs::metadata(&source.source_path)?.len());
    }
    Ok(view)
}

pub fn bind(
    database: &mut Database,
    _data_dir: &std::path::Path,
    client: &DraftClient,
    intent: UploadIntent,
    source: LocalAttachmentSourceRef,
) -> Result<CommandExecution> {
    let envelope = envelope(client, intent)?;
    ensure!(
        source.id == envelope.payload.intent.command_id,
        "upload reference changed"
    );
    ensure!(
        source.display_name == envelope.payload.intent.display_name
            && source.observed_byte_size == Some(envelope.payload.intent.byte_size),
        "upload observation changed"
    );
    DomainCommandGateway.execute(database, &envelope, |transaction| {
        let intent = &envelope.payload.intent;
        match &intent.target {
            UploadTarget::Camp => {
                ensure!(
                    transaction.query_row(
                        "SELECT EXISTS(SELECT 1 FROM camp WHERE id = ?1)",
                        [&intent.camp_id],
                        |row| row.get::<_, bool>(0),
                    )?,
                    "camp.not_found"
                );
            }
            UploadTarget::SingleChat { conversation_id } => {
                ensure!(transaction.query_row("SELECT EXISTS(SELECT 1 FROM conversation WHERE id=?1 AND camp_id=?2 AND kind='single_chat' AND ended_at IS NULL)", rusqlite::params![conversation_id,intent.camp_id], |r| r.get::<_, bool>(0))?, "single_chat.camp_mismatch");
                crate::single_chat::SingleChatService::for_client(client.clone()).commit_source_attachment_in_transaction(transaction, conversation_id, intent.expected_revision, source.clone())?;
            }
            UploadTarget::SingleChatPending { conversation_id, pending_input_id, edit_token } => crate::single_chat::SingleChatService::for_client(client.clone()).commit_pending_source_attachment_in_transaction(transaction, &intent.camp_id, conversation_id, pending_input_id, intent.expected_revision, edit_token, source.clone())?,
        }
        let payload = if matches!(intent.target, UploadTarget::Camp) {
            json!({"attachmentRefId":intent.command_id, "source":source})
        } else {
            json!({"attachmentRefId":intent.command_id, "draftId":client.draft_id(&intent.camp_id), "revision":intent.expected_revision+1})
        };
        Ok(CommandHandlerResult::applied("attachment.upload_bound", payload, None))
    })
}
