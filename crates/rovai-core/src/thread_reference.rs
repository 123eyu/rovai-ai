//! User-selected public references. Saved messages own their labels; targets own their live content.
use std::collections::BTreeMap;

use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    camp_content::StructuredThreadMessageSegment as Segment, camp_id::ThreadId,
    command::CommandHandlerResult,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceKind {
    Thread,
    Mission,
}

impl ReferenceKind {
    fn path(self) -> &'static str {
        match self {
            Self::Thread => "thread",
            Self::Mission => "mission",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReferenceIdentity {
    pub kind: ReferenceKind,
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceCandidate {
    pub kind: ReferenceKind,
    pub id: String,
    pub title: String,
    pub project_binding_kind: String,
    pub project_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListParams {
    thread_id: String,
    kind: ReferenceKind,
    #[serde(default)]
    query: String,
    cursor: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferencePage {
    items: Vec<ReferenceCandidate>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResolveParams {
    thread_id: String,
    references: Vec<ReferenceIdentity>,
}

pub fn validate_id(kind: ReferenceKind, id: &str) -> Result<()> {
    match kind {
        ReferenceKind::Thread => {
            ThreadId::parse(id)?;
        }
        ReferenceKind::Mission => {
            let raw = id
                .strip_prefix("rvm_")
                .context("Invalid Mission reference ID")?;
            let uuid = uuid::Uuid::parse_str(raw)?;
            ensure!(
                raw == uuid.simple().to_string()
                    && uuid.get_version_num() == 7
                    && uuid.get_variant() == uuid::Variant::RFC4122,
                "Invalid Mission reference ID"
            );
        }
    }
    Ok(())
}

pub fn validate_label(label: &str) -> Result<()> {
    ensure!(
        !label.is_empty()
            && label.trim() == label
            && label.chars().count() <= 500
            && !label.chars().any(char::is_control),
        "Invalid reference label"
    );
    Ok(())
}

pub fn render_link(kind: ReferenceKind, id: &str, title: &str) -> String {
    let mut escaped = String::new();
    for c in title.chars() {
        if c.is_ascii_punctuation() {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    format!("[{escaped}](rovai://{}/{id})", kind.path())
}

fn target(
    connection: &Connection,
    current: &str,
    kind: ReferenceKind,
    id: &str,
) -> Result<Option<ReferenceCandidate>> {
    if validate_id(kind, id).is_err() {
        return Ok(None);
    }
    let sql = match kind {
        ReferenceKind::Thread => {
            "SELECT c.id,c.title,c.project_binding_kind,c.project_path FROM camp c WHERE c.id=?1 AND c.id<>?2 AND c.deletion_operation_id IS NULL AND c.activation_state='active' AND NOT EXISTS(SELECT 1 FROM mission m WHERE m.camp_id=c.id)"
        }
        ReferenceKind::Mission => {
            "SELECT m.id,m.title,c.project_binding_kind,c.project_path FROM mission m JOIN camp c ON c.id=m.camp_id WHERE m.id=?1 AND c.id<>?2 AND c.deletion_operation_id IS NULL"
        }
    };
    Ok(connection
        .query_row(sql, params![id, current], |row| {
            Ok(ReferenceCandidate {
                kind,
                id: row.get(0)?,
                title: row.get(1)?,
                project_binding_kind: row.get(2)?,
                project_path: row.get(3)?,
            })
        })
        .optional()?)
}

fn validate_scope(connection: &Connection, current: &str) -> Result<()> {
    ThreadId::parse(current)?;
    let exists: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM camp WHERE id=?1 AND deletion_operation_id IS NULL)",
        [current],
        |r| r.get(0),
    )?;
    ensure!(exists, "Thread is unavailable");
    Ok(())
}

pub fn resolve(
    connection: &Connection,
    params: ResolveParams,
) -> Result<Vec<Option<ReferenceCandidate>>> {
    validate_scope(connection, &params.thread_id)?;
    ensure!(params.references.len() <= 128, "Too many references");
    params
        .references
        .iter()
        .map(|r| target(connection, &params.thread_id, r.kind, &r.id))
        .collect()
}

// A cursor is scoped to the search and carries its last ordering key. No total-count query,
// OFFSET scan, AgentRun, or history content is needed to browse the public directory.
#[derive(Serialize, Deserialize)]
struct Cursor(String, ReferenceKind, String, String, String);

pub fn list(connection: &Connection, params: ListParams) -> Result<ReferencePage> {
    validate_scope(connection, &params.thread_id)?;
    let query = params.query.trim().to_lowercase();
    ensure!(query.chars().count() <= 128, "Search query is too long");
    let cursor: Option<Cursor> = params
        .cursor
        .map(|encoded| -> Result<Cursor> {
            ensure!(encoded.len() <= 4096, "Invalid reference cursor");
            Ok(serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded)?)?)
        })
        .transpose()?;
    if let Some(c) = &cursor {
        ensure!(
            c.0 == params.thread_id && c.1 == params.kind && c.2 == query,
            "Reference cursor does not match search"
        );
    }
    let mut pattern = String::from("%");
    for c in query.chars().filter(|c| !c.is_whitespace()) {
        if matches!(c, '%' | '_' | '\\') {
            pattern.push('\\');
        }
        pattern.push(c);
        pattern.push('%');
    }
    let (id, title, join, visible) = match params.kind {
        ReferenceKind::Thread => (
            "c.id",
            "c.title",
            "",
            "AND c.activation_state='active' AND NOT EXISTS(SELECT 1 FROM mission m WHERE m.camp_id=c.id)",
        ),
        ReferenceKind::Mission => ("m.id", "m.title", "JOIN mission m ON m.camp_id=c.id", ""),
    };
    let activity = "COALESCE(c.navigation_activity_at,c.created_at)";
    let sql = format!(
        "SELECT {id},{title},c.project_binding_kind,c.project_path,{activity} FROM camp c {join} WHERE c.id<>?1 AND c.deletion_operation_id IS NULL {visible} AND lower({title}) LIKE ?2 ESCAPE '\\' AND (?3 IS NULL OR {activity}<?3 OR ({activity}=?3 AND {id}>?4)) ORDER BY {activity} DESC,{id} LIMIT 9"
    );
    let mut statement = connection.prepare(&sql)?;
    let mut rows = statement
        .query_map(
            params![
                params.thread_id,
                pattern,
                cursor.as_ref().map(|c| &c.3),
                cursor.as_ref().map(|c| &c.4)
            ],
            |r| {
                Ok((
                    ReferenceCandidate {
                        kind: params.kind,
                        id: r.get(0)?,
                        title: r.get(1)?,
                        project_binding_kind: r.get(2)?,
                        project_path: r.get(3)?,
                    },
                    r.get::<_, String>(4)?,
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = rows.len() > 8;
    rows.truncate(8);
    let next_cursor = if has_more {
        let (last, at) = rows.last().expect("nonempty page");
        Some(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Cursor(
            params.thread_id,
            params.kind,
            query,
            at.clone(),
            last.id.clone(),
        ))?))
    } else {
        None
    };
    Ok(ReferencePage {
        items: rows.into_iter().map(|(item, _)| item).collect(),
        next_cursor,
    })
}

pub fn contains_reference(content: &[Segment]) -> bool {
    content.iter().any(|s| {
        matches!(
            s,
            Segment::ThreadReference { .. } | Segment::MissionReference { .. }
        )
    })
}

/// Only called inside the first publication transaction, after command identity replay.
pub fn capture_titles(
    connection: &Connection,
    current: &str,
    content: &mut [Segment],
) -> Result<Result<(), CommandHandlerResult>> {
    let mut titles = BTreeMap::new();
    for (index, segment) in content.iter_mut().enumerate() {
        let (kind, id, title) = match segment {
            Segment::ThreadReference {
                thread_id,
                title_at_send,
            } => (ReferenceKind::Thread, thread_id, title_at_send),
            Segment::MissionReference {
                mission_id,
                title_at_send,
            } => (ReferenceKind::Mission, mission_id, title_at_send),
            _ => continue,
        };
        let key = (kind, id.clone());
        if !titles.contains_key(&key) {
            let Some(item) = target(connection, current, kind, id)? else {
                return Ok(Err(CommandHandlerResult::rejected(
                    "reference_unavailable",
                    json!({"message":"引用不可用","segmentIndex":index,"kind":kind,"id":id}),
                )));
            };
            titles.insert(key.clone(), item.title);
        }
        *title = titles[&key].clone();
    }
    Ok(Ok(()))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Owns live directory pagination, cursor scoping, and identity-only source resolution.
    // Minimal SQLite tables are sufficient; publication rollback belongs to the existing
    // Pending invitation transaction test, not a second full Runtime fixture here.
    #[test]
    fn directory_search_pages_all_matches_and_retains_only_public_targets() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE camp(id TEXT PRIMARY KEY,title TEXT,project_binding_kind TEXT,project_path TEXT,deletion_operation_id TEXT,activation_state TEXT,navigation_activity_at TEXT,created_at TEXT); CREATE TABLE mission(id TEXT PRIMARY KEY,camp_id TEXT,title TEXT);").unwrap();
        let current = ThreadId::new().to_string();
        let insert = |id: &str, title: &str| {
            connection.execute("INSERT INTO camp VALUES (?1,?2,'directory','/project',NULL,'active','2026-10-22','2026-10-22')", params![id,title]).unwrap();
        };
        insert(&current, "登录当前");
        let ids: Vec<_> = (0..19).map(|_| ThreadId::new().to_string()).collect();
        for id in &ids {
            insert(id, "登录改造");
        }
        connection
            .execute(
                "UPDATE camp SET deletion_operation_id='deleting' WHERE id=?1",
                [&ids[0]],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE camp SET activation_state='pending' WHERE id=?1",
                [&ids[1]],
            )
            .unwrap();
        let mission_id = format!("rvm_{}", uuid::Uuid::now_v7().simple());
        connection
            .execute(
                "INSERT INTO mission VALUES (?1,?2,'登录使命')",
                params![mission_id, ids[2]],
            )
            .unwrap();
        let list_params = |cursor| ListParams {
            thread_id: current.clone(),
            kind: ReferenceKind::Thread,
            query: "登改".into(),
            cursor,
        };
        let first = list(&connection, list_params(None)).unwrap();
        assert_eq!(first.items.len(), 8);
        let second = list(&connection, list_params(first.next_cursor.clone())).unwrap();
        assert_eq!(second.items.len(), 8);
        assert!(second.next_cursor.is_none());
        let unique: std::collections::HashSet<_> = first
            .items
            .iter()
            .chain(second.items.iter())
            .map(|r| &r.id)
            .collect();
        assert_eq!(unique.len(), 16);
        let mut wrong_query = list_params(first.next_cursor);
        wrong_query.query = "其他".into();
        assert!(list(&connection, wrong_query).is_err());
        let missions = list(
            &connection,
            ListParams {
                thread_id: current.clone(),
                kind: ReferenceKind::Mission,
                query: "登录".into(),
                cursor: None,
            },
        )
        .unwrap();
        assert_eq!(missions.items[0].id, mission_id);
        assert!(
            target(&connection, &current, ReferenceKind::Thread, &ids[2])
                .unwrap()
                .is_none()
        );
        assert!(
            target(&connection, &current, ReferenceKind::Thread, &current)
                .unwrap()
                .is_none()
        );
        assert!(
            target(
                &connection,
                &current,
                ReferenceKind::Thread,
                "private_session"
            )
            .unwrap()
            .is_none()
        );
        let literal = ThreadId::new().to_string();
        insert(&literal, "100%_完成");
        assert_eq!(
            list(
                &connection,
                ListParams {
                    thread_id: current.clone(),
                    kind: ReferenceKind::Thread,
                    query: "%_".into(),
                    cursor: None
                }
            )
            .unwrap()
            .items
            .len(),
            1
        );

        let mut content = vec![
            Segment::MissionReference {
                mission_id: mission_id.clone(),
                title_at_send: "forged".into(),
            },
            Segment::MissionReference {
                mission_id: mission_id.clone(),
                title_at_send: "another".into(),
            },
        ];
        capture_titles(&connection, &current, &mut content)
            .unwrap()
            .unwrap();
        assert_eq!(content[0], content[1]);
        let rendered = crate::camp_content::render_plain_text(&content, |_| None).unwrap();
        assert_eq!(
            rendered
                .matches(&format!("rovai://mission/{mission_id}"))
                .count(),
            2
        );
        connection
            .execute("DELETE FROM mission WHERE id=?1", [&mission_id])
            .unwrap();
        assert_eq!(
            crate::camp_content::render_plain_text(&content, |_| None).unwrap(),
            rendered
        );
        assert!(
            capture_titles(&connection, &current, &mut content)
                .unwrap()
                .is_err()
        );
    }
}
