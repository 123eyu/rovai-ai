//! User delivery routing. Message bodies remain owned by CampMessage.
use anyhow::Result;
use rusqlite::{Connection, Transaction, params};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UserDeliveryMode {
    #[default]
    Start,
    Steer,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActiveInputTarget {
    pub agent_run_id: String,
    pub execution_epoch: i64,
}

/// Adapters whose active-input transport is fenced to this Run/epoch.
pub fn supports_active_input(adapter: &str) -> bool {
    matches!(
        adapter,
        "codex-cli"
            | "claude-code-cli"
            | "pi"
            | "codebuddy-cli"
            | "qwen-code"
            | "grok-build"
            | "kiro-cli"
            | "zcode-app"
    )
}

/// Proof that this source was not written, or was removed from an unconsumed
/// native queue. Transport failures must never be converted to this error.
#[derive(Debug)]
pub struct ActiveInputNotAccepted;

impl std::fmt::Display for ActiveInputNotAccepted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("The target execution no longer accepts this input")
    }
}
impl std::error::Error for ActiveInputNotAccepted {}

pub(crate) fn route_user_message(
    tx: &Transaction<'_>,
    message_id: &str,
    expected_targets: Option<&[ActiveInputTarget]>,
) -> Result<()> {
    // Admission captures the intended execution; later preparation may not retarget it.
    let targets = {
        let mut query = tx.prepare("SELECT d.id,r.id,r.runtime_adapter_kind,r.execution_epoch FROM camp_message_delivery d
            JOIN camp_message m ON m.id=d.message_id
            JOIN conversation c ON c.agent_id=d.recipient_agent_id
            JOIN agent_run r ON r.camp_id=d.camp_id AND r.conversation_id=c.id
            WHERE m.id=?1 AND m.author_type='user' AND d.status='waiting'
              AND r.invocation_kind='batch' AND r.status IN ('running','waiting') AND r.cancel_requested_at IS NULL
              AND EXISTS(SELECT 1 FROM runtime_input_delivery i WHERE i.agent_run_id=r.id
                AND i.execution_epoch=r.execution_epoch AND i.input_kind='start' AND i.status='accepted'
                AND i.native_binding_id=c.native_binding_id AND i.native_binding_generation=c.native_binding_generation)")?;
        query
            .query_map([message_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (delivery, run, adapter, epoch) in targets {
        if supports_active_input(&adapter)
            && expected_targets.is_none_or(|targets| {
                targets
                    .iter()
                    .any(|t| t.agent_run_id == run && t.execution_epoch == epoch)
            })
        {
            tx.execute("UPDATE camp_message_delivery SET requested_mode='steer',status='claimed',
                claimed_agent_run_id=?2,target_execution_epoch=?3,claimed_at=updated_at,version=version+1 WHERE id=?1 AND status='waiting'",
                params![delivery,run,epoch])?;
        }
    }
    Ok(())
}

#[derive(Debug)]
pub struct PendingInput {
    pub delivery_id: String,
    pub agent_run_id: String,
    pub execution_epoch: i64,
}

/// One source per execution, in existing Delivery order. Ambiguity fences later inputs.
pub fn pending_inputs(connection: &Connection) -> Result<Vec<PendingInput>> {
    let mut query = connection.prepare("SELECT d.id,r.id,r.execution_epoch FROM camp_message_delivery d
        JOIN agent_run r ON r.id=d.claimed_agent_run_id
        WHERE d.requested_mode='steer' AND d.status='claimed' AND r.status IN ('running','waiting')
          AND r.cancel_requested_at IS NULL AND d.target_execution_epoch=r.execution_epoch
          AND NOT EXISTS(SELECT 1 FROM context_manifest m JOIN runtime_input_delivery i ON i.context_manifest_id=m.id
              WHERE m.source_delivery_id=d.id AND (i.status<>'prepared' OR i.dispatch_started_at IS NOT NULL))
          AND NOT EXISTS(SELECT 1 FROM camp_message_delivery earlier
              WHERE earlier.claimed_agent_run_id=r.id AND earlier.requested_mode='steer'
                AND earlier.status='claimed' AND earlier.queue_sequence<d.queue_sequence)
        ORDER BY d.queue_sequence,d.id")?;
    Ok(query
        .query_map([], |r| {
            Ok(PendingInput {
                delivery_id: r.get(0)?,
                agent_run_id: r.get(1)?,
                execution_epoch: r.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?)
}

/// Called only with proof that native submission did not accept this input.
pub fn return_to_queue(tx: &Transaction<'_>, delivery_id: &str, now: &str) -> Result<()> {
    tx.execute("UPDATE camp_message_delivery SET requested_mode='start',status='waiting',claimed_agent_run_id=NULL,target_execution_epoch=NULL,
        claimed_at=NULL,ended_at=NULL,failure_code=NULL,updated_at=?2,version=version+1
        WHERE id=?1 AND requested_mode='steer' AND (status='claimed' OR (status='failed' AND failure_code='input_delivery_unknown'))
          AND EXISTS(SELECT 1 FROM agent_run r WHERE r.id=claimed_agent_run_id AND r.cancel_requested_at IS NULL AND r.status IN ('running','waiting','succeeded'))
          AND NOT EXISTS(SELECT 1 FROM context_manifest m JOIN runtime_input_delivery i ON i.context_manifest_id=m.id
              WHERE m.source_delivery_id=?1 AND (i.status IN ('accepted','delivery_unknown')
                  OR (i.status='prepared' AND i.dispatch_started_at IS NOT NULL)))", params![delivery_id,now])?;
    Ok(())
}

pub(crate) fn settle_execution(
    tx: &Transaction<'_>,
    run_id: &str,
    run_status: &str,
    now: &str,
) -> Result<()> {
    // Prepared-but-unsent sources survive ordinary Run success. Dispatch-started sources never replay.
    tx.execute("UPDATE runtime_input_delivery SET status='not_accepted',resolved_at=?2,updated_at=?2
        WHERE agent_run_id=?1 AND input_kind='steer' AND status='prepared' AND dispatch_started_at IS NULL", params![run_id,now])?;
    if run_status == "succeeded" {
        tx.execute("UPDATE camp_message_delivery SET requested_mode='start',status='waiting',claimed_agent_run_id=NULL,target_execution_epoch=NULL,
        claimed_at=NULL,ended_at=NULL,updated_at=?2,version=version+1
        WHERE claimed_agent_run_id=?1 AND requested_mode='steer' AND status='claimed'
          AND NOT EXISTS(SELECT 1 FROM context_manifest m JOIN runtime_input_delivery i ON i.context_manifest_id=m.id
              WHERE m.source_delivery_id=camp_message_delivery.id AND i.status IN ('prepared','accepted','delivery_unknown'))", params![run_id,now])?;
    }
    tx.execute("UPDATE runtime_input_delivery SET status='delivery_unknown',updated_at=?2
        WHERE agent_run_id=?1 AND input_kind='steer' AND status='prepared' AND dispatch_started_at IS NOT NULL", params![run_id,now])?;
    tx.execute("UPDATE camp_message_delivery SET status='failed',failure_code='input_delivery_unknown',ended_at=?2,updated_at=?2,version=version+1
        WHERE claimed_agent_run_id=?1 AND requested_mode='steer' AND status='claimed'
          AND EXISTS(SELECT 1 FROM context_manifest m JOIN runtime_input_delivery i ON i.context_manifest_id=m.id
              WHERE m.source_delivery_id=camp_message_delivery.id AND i.status='delivery_unknown')", params![run_id,now])?;
    Ok(())
}
