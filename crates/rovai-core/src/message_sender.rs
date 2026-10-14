//! Model-only sender identities. Stored authors remain the routing and authorization authority.
use std::collections::BTreeMap;

use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MessageSender {
    sender_type: String,
    sender_id: String,
    // None omits the field (User/legacy); Some(None) emits null (unknown name).
    #[serde(skip_serializing_if = "Option::is_none")]
    sender_name: Option<Option<String>>,
}

impl MessageSender {
    pub(crate) fn legacy(author_type: &str, author_id: &str) -> Self {
        Self {
            sender_type: author_type.into(),
            sender_id: author_id.into(),
            sender_name: None,
        }
    }

    pub(crate) fn insert_into(&self, message: &mut Value) {
        let fields = serde_json::to_value(self).expect("sender fields serialize to JSON");
        message
            .as_object_mut()
            .expect("message projection is an object")
            .extend(fields.as_object().expect("sender is an object").clone());
    }
}

/// Request-local cache, including misses. Never filters authors by current membership.
#[derive(Default)]
pub(crate) struct SenderNames {
    names: BTreeMap<String, Option<String>>,
    frozen: bool,
}

impl SenderNames {
    /// Non-batch shared history uses the same Run-owned JSON slot as batch context.
    /// Old unmaterialized runs without this optional snapshot keep the existing path.
    pub(crate) fn for_shared_run(connection: &Connection, run_id: &str) -> Result<Self> {
        let json: Option<String> = connection
            .query_row(
                "SELECT context_json FROM agent_run_claim_context WHERE agent_run_id=?1",
                [run_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(json) = json else {
            return Ok(Self::default());
        };
        let mut value: Value = serde_json::from_str(&json)?;
        let Some(names) = value
            .as_object_mut()
            .and_then(|object| object.remove("sharedSenderNames"))
        else {
            return Ok(Self::default());
        };
        Ok(Self {
            names: serde_json::from_value(names)?,
            frozen: true,
        })
    }

    pub(crate) fn project(
        &mut self,
        connection: &Connection,
        author_type: &str,
        author_id: &str,
    ) -> Result<MessageSender> {
        Ok(match author_type {
            "user" | "external_principal" => MessageSender::legacy("user", "user"),
            "system" => MessageSender {
                sender_type: "system".into(),
                sender_id: "system".into(),
                sender_name: Some(None),
            },
            "agent" => {
                let name = match self.names.entry(author_id.into()) {
                    std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
                    std::collections::btree_map::Entry::Vacant(entry) if self.frozen => {
                        entry.insert(None)
                    }
                    std::collections::btree_map::Entry::Vacant(entry) => entry.insert(
                        connection
                            .query_row(
                                "SELECT display_name FROM agent_profile WHERE id = ?1",
                                [author_id],
                                |row| row.get::<_, Option<String>>(0),
                            )
                            .optional()?
                            .flatten()
                            .filter(|name| !name.trim().is_empty()),
                    ),
                };
                MessageSender {
                    sender_type: "agent".into(),
                    sender_id: author_id.into(),
                    sender_name: Some(name.clone()),
                }
            }
            _ => anyhow::bail!("Unsupported stored message author type: {author_type}"),
        })
    }
}

/// Called in the existing lease-claim transaction, never on a Session boundary.
pub(crate) fn freeze_shared_senders(connection: &Connection, run_id: &str) -> Result<()> {
    let needs_snapshot: bool = connection.query_row(
        "SELECT invocation_kind <> 'batch'
            AND NOT EXISTS(SELECT 1 FROM agent_run_claim_context WHERE agent_run_id=?1)
            AND NOT EXISTS(SELECT 1 FROM context_manifest WHERE agent_run_id=?1)
         FROM agent_run WHERE id=?1",
        [run_id],
        |row| row.get(0),
    )?;
    if !needs_snapshot {
        return Ok(());
    }
    // Read only distinct author IDs inside the Run's existing public fence. This
    // neither selects history for the model nor filters authors by current roster.
    let mut statement = connection.prepare(
        "SELECT DISTINCT message.author_id FROM agent_run AS run
         LEFT JOIN camp_turn AS turn ON turn.id=run.camp_turn_id
         JOIN camp_message AS message ON message.camp_id=COALESCE(run.camp_id,turn.camp_id)
         WHERE run.id=?1 AND message.sequence<=COALESCE(run.current_public_tail_sequence,run.initial_camp_context_through_sequence)
           AND message.author_type='agent'",
    )?;
    let authors = statement
        .query_map([run_id], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut names = SenderNames::default();
    for id in authors {
        names.project(connection, "agent", &id)?;
    }
    connection.execute(
        "INSERT INTO agent_run_claim_context(agent_run_id,context_json) VALUES(?1,?2)",
        rusqlite::params![
            run_id,
            serde_json::json!({"sharedSenderNames":names.names}).to_string()
        ],
    )?;
    Ok(())
}
