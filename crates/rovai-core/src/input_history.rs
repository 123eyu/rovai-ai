//! User composer recall. Reads existing submissions; never owns messages, drafts or retries.
use anyhow::{Context, Result, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::camp_content::{
    ComposerDocument, ComposerSegment, StructuredThreadMessageContent,
    StructuredThreadMessageSegment, composer_document_from_content,
};
use crate::current_user::CURRENT_USER_ID;

const PAGE_SIZE: usize = 20;
// ECMAScript trim whitespace: eligibility matches the client without trimming saved content.
const WHITESPACE: &str = " \t\n\r\u{b}\u{c}\u{a0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputHistoryItem {
    history_id: String,
    content: ComposerDocument,
    cursor: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputHistoryPage {
    items: Vec<InputHistoryItem>,
    next_cursor: Option<String>,
    has_more: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThreadInputHistoryQuery {
    pub thread_id: crate::camp_id::ThreadId,
    pub cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SingleInputHistoryQuery {
    pub thread_id: crate::camp_id::ThreadId,
    pub conversation_id: String,
    pub cursor: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", deny_unknown_fields)]
enum Cursor {
    Thread {
        thread_id: String,
        sequence: i64,
    },
    Single {
        thread_id: String,
        conversation_id: String,
        submitted_at: String,
        history_id: String,
    },
}

fn decode(value: &str) -> Result<Cursor> {
    ensure!(value.len() <= 4096, "Input history cursor is too long");
    serde_json::from_slice(&URL_SAFE_NO_PAD.decode(value)?).context("Invalid input history cursor")
}

fn encode(cursor: Cursor) -> Result<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&cursor)?))
}

fn page(mut items: Vec<InputHistoryItem>) -> InputHistoryPage {
    let has_more = items.len() > PAGE_SIZE;
    items.truncate(PAGE_SIZE);
    InputHistoryPage {
        next_cursor: items.last().map(|item| item.cursor.clone()),
        items,
        has_more,
    }
}

fn text_document(text: String) -> ComposerDocument {
    ComposerDocument {
        segments: vec![ComposerSegment::Text { text }],
        ..ComposerDocument::default()
    }
}

pub fn thread(connection: &Connection, query: ThreadInputHistoryQuery) -> Result<InputHistoryPage> {
    let thread_id = query.thread_id.as_str();
    let before = match query.cursor.as_deref().map(decode).transpose()? {
        None => i64::MAX,
        Some(Cursor::Thread {
            thread_id: scope,
            sequence,
        }) if scope == thread_id && sequence > 0 => sequence,
        _ => anyhow::bail!("Input history cursor does not belong to this Thread"),
    };
    let mut statement = connection.prepare(
        "SELECT id, sequence, body, structured_content_json
         FROM camp_message
         WHERE camp_id = ?1 AND author_type = 'user' AND author_id = ?2 AND sequence < ?3
           AND ((json_array_length(structured_content_json) = 0 AND trim(body, ?4) <> '')
             OR EXISTS (SELECT 1 FROM json_each(structured_content_json) AS segment
               WHERE json_extract(segment.value, '$.kind') IN ('member_mention', 'all_members_mention', 'skill_mention')
                 OR (json_extract(segment.value, '$.kind') = 'text'
                     AND trim(json_extract(segment.value, '$.text'), ?4) <> '')))
         ORDER BY sequence DESC LIMIT 21",
    )?;
    let rows = statement.query_map(
        params![thread_id, CURRENT_USER_ID, before, WHITESPACE],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        },
    )?;
    let items = rows
        .map(|row| {
            let (history_id, sequence, body, json) = row?;
            let mut content: StructuredThreadMessageContent = serde_json::from_str(&json)?;
            let document = if content.is_empty() {
                text_document(body)
            } else {
                // Core-owned quote/reference segments are not editable user input.
                content.retain(|segment| {
                    !matches!(
                        segment,
                        StructuredThreadMessageSegment::ExternalQuote { .. }
                            | StructuredThreadMessageSegment::CurrentUserMention { .. }
                    )
                });
                composer_document_from_content(&content)?
            };
            Ok(InputHistoryItem {
                history_id,
                content: document,
                cursor: encode(Cursor::Thread {
                    thread_id: thread_id.into(),
                    sequence,
                })?,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(page(items))
}

pub fn single(connection: &Connection, query: SingleInputHistoryQuery) -> Result<InputHistoryPage> {
    let thread_id = query.thread_id.as_str();
    let conversation_id = &query.conversation_id;
    let valid: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM conversation WHERE id = ?1 AND camp_id = ?2 AND kind = 'single_chat')",
        params![conversation_id, thread_id], |row| row.get(0),
    )?;
    ensure!(
        valid,
        "Input history Conversation does not belong to this Thread"
    );
    let (before_time, before_id) = match query.cursor.as_deref().map(decode).transpose()? {
        None => (None, None),
        Some(Cursor::Single {
            thread_id: scope,
            conversation_id: conversation,
            submitted_at,
            history_id,
        }) if scope == thread_id && conversation == *conversation_id => {
            (Some(submitted_at), Some(history_id))
        }
        _ => anyhow::bail!("Input history cursor does not belong to this Conversation"),
    };
    let mut statement = connection.prepare(
        "WITH inputs AS (
           SELECT m.id AS history_id, m.created_at AS submitted_at, m.body
           FROM conversation_message m
           WHERE m.conversation_id = ?1 AND m.author_type = 'user' AND m.author_id = ?2
             AND m.id NOT IN (SELECT published_conversation_message_id FROM single_chat_pending_input
               WHERE conversation_id = ?1 AND published_conversation_message_id IS NOT NULL)
           UNION ALL
           SELECT p.id, p.created_at,
             CASE WHEN p.published_conversation_message_id IS NULL THEN p.body ELSE m.body END
           FROM single_chat_pending_input p
           LEFT JOIN conversation_message m ON m.id = p.published_conversation_message_id
             AND m.conversation_id = p.conversation_id AND m.author_type = 'user' AND m.author_id = ?2
           WHERE p.conversation_id = ?1 AND p.user_id = ?2
         )
         SELECT history_id, submitted_at, body FROM inputs
         WHERE trim(body, ?5) <> ''
           AND (?3 IS NULL OR submitted_at < ?3 OR (submitted_at = ?3 AND history_id < ?4))
         ORDER BY submitted_at DESC, history_id DESC LIMIT 21",
    )?;
    let rows = statement.query_map(
        params![
            conversation_id,
            CURRENT_USER_ID,
            before_time,
            before_id,
            WHITESPACE
        ],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        },
    )?;
    let items = rows
        .map(|row| {
            let (history_id, submitted_at, body) = row?;
            let cursor = encode(Cursor::Single {
                thread_id: thread_id.into(),
                conversation_id: conversation_id.clone(),
                submitted_at,
                history_id: history_id.clone(),
            })?;
            Ok(InputHistoryItem {
                history_id,
                content: text_document(body),
                cursor,
            })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(page(items))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camp_id::ThreadId;

    // These queries have their own filtered/keyset seam; a minimal SQLite fixture
    // proves ordering and joins without constructing Core, Runtime or a full schema.
    #[test]
    fn public_input_history_pages_only_recallable_current_user_submissions() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE camp_message(
            id TEXT, camp_id TEXT, sequence INTEGER, author_type TEXT, author_id TEXT,
            body TEXT, structured_content_json TEXT);",
            )
            .unwrap();
        let id = ThreadId::new();
        for sequence in 1..=43 {
            connection
                .execute(
                    "INSERT INTO camp_message VALUES (?1,?2,?3,'user',?4,?5,'[]')",
                    params![
                        format!("m{sequence}"),
                        id.as_str(),
                        sequence,
                        CURRENT_USER_ID,
                        " \ncode\n "
                    ],
                )
                .unwrap();
        }
        // These rows are above the page boundary but must not consume page slots.
        for (sequence, author, user, body, content) in [
            (44, "agent", CURRENT_USER_ID, "agent", "[]"),
            (45, "user", "other", "other user", "[]"),
            (46, "user", CURRENT_USER_ID, "\t\n\u{3000}\u{feff}", "[]"),
            (47, "user", CURRENT_USER_ID, "", "[]"), // withdrawn / attachment-only
            (
                48,
                "user",
                CURRENT_USER_ID,
                "",
                r#"[{"kind":"member_mention","agentId":"agent_1"},{"kind":"skill_mention","skillId":"skill","nameAtSend":"test-skill"}]"#,
            ),
        ] {
            connection
                .execute(
                    "INSERT INTO camp_message VALUES (?1,?2,?3,?4,?5,?6,?7)",
                    params![
                        format!("m{sequence}"),
                        id.as_str(),
                        sequence,
                        author,
                        user,
                        body,
                        content
                    ],
                )
                .unwrap();
        }
        connection
            .execute(
                "INSERT INTO camp_message VALUES ('outside','outside',99,'user',?1,'outside','[]')",
                [CURRENT_USER_ID],
            )
            .unwrap();
        let first = thread(
            &connection,
            ThreadInputHistoryQuery {
                thread_id: id.clone(),
                cursor: None,
            },
        )
        .unwrap();
        assert_eq!(first.items.len(), 20);
        assert!(first.has_more);
        assert_eq!(first.items[0].history_id, "m48");
        assert_eq!(first.items[0].content.segments.len(), 2);
        assert_eq!(first.items[1].content, text_document(" \ncode\n ".into()));
        assert_eq!(first.items[19].history_id, "m25");
        let second = thread(
            &connection,
            ThreadInputHistoryQuery {
                thread_id: id.clone(),
                cursor: first.next_cursor.clone(),
            },
        )
        .unwrap();
        assert_eq!(second.items[0].history_id, "m24");
        assert_eq!(second.items.len(), 20);
        let last = thread(
            &connection,
            ThreadInputHistoryQuery {
                thread_id: id.clone(),
                cursor: second.next_cursor,
            },
        )
        .unwrap();
        assert_eq!(last.items.len(), 4);
        assert!(!last.has_more);
        // Each item is a usable exclusive cursor, including after a client trim.
        let from_item = thread(
            &connection,
            ThreadInputHistoryQuery {
                thread_id: id,
                cursor: Some(first.items[3].cursor.clone()),
            },
        )
        .unwrap();
        assert_eq!(from_item.items[0].history_id, "m40");
        assert!(
            thread(
                &connection,
                ThreadInputHistoryQuery {
                    thread_id: ThreadId::new(),
                    cursor: first.next_cursor
                }
            )
            .is_err()
        );
    }

    #[test]
    fn single_input_history_keeps_pending_identity_across_publication_and_cancellation() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("CREATE TABLE conversation(id TEXT, camp_id TEXT, kind TEXT);
            CREATE TABLE conversation_message(id TEXT, conversation_id TEXT, author_type TEXT, author_id TEXT, body TEXT, created_at TEXT);
            CREATE TABLE single_chat_pending_input(id TEXT, conversation_id TEXT, user_id TEXT, body TEXT,
                created_at TEXT, state TEXT, published_conversation_message_id TEXT);").unwrap();
        let id = ThreadId::new();
        connection.execute("INSERT INTO conversation VALUES ('single',?1,'single_chat'),('other',?1,'camp_member')", [id.as_str()]).unwrap();
        for sequence in 1..=22 {
            connection.execute("INSERT INTO conversation_message VALUES (?1,'single','user',?2,?3,'2026-10-20T00:00:00Z')",
                params![format!("direct{sequence:02}"), CURRENT_USER_ID, format!("body{sequence}")]).unwrap();
        }
        for (pending, state, body, published) in [
            ("p1", "queued", "queued", None),
            ("p2", "needs_repair", "needs repair", None),
            ("p3", "cancelled", "cancelled", None),
            ("p4", "published", "old text", Some("published")),
            ("p5", "published", "must not resurrect", Some("removed")),
            ("p6", "queued", "\t\n\u{3000}", None),
        ] {
            connection.execute("INSERT INTO single_chat_pending_input VALUES (?1,'single',?2,?3,'2026-10-21T00:00:00Z',?4,?5)",
                params![pending, CURRENT_USER_ID, body, state, published]).unwrap();
        }
        connection
            .execute(
                "INSERT INTO conversation_message VALUES
            ('published','single','user',?1,'current published body','2026-10-22T00:00:00Z'),
            ('removed','single','user',?1,'','2026-10-22T00:00:00Z'),
            ('agent','single','agent','agent_1','reply','2026-10-22T00:00:00Z'),
            ('another-user','single','user','another','private','2026-10-22T00:00:00Z'),
            ('other-conversation','other','user',?1,'other','2026-10-22T00:00:00Z')",
                [CURRENT_USER_ID],
            )
            .unwrap();
        let query = |cursor| SingleInputHistoryQuery {
            thread_id: id.clone(),
            conversation_id: "single".into(),
            cursor,
        };
        let first = single(&connection, query(None)).unwrap();
        assert_eq!(first.items.len(), 20);
        assert!(first.has_more);
        assert_eq!(
            first
                .items
                .iter()
                .take(4)
                .map(|item| item.history_id.as_str())
                .collect::<Vec<_>>(),
            ["p4", "p3", "p2", "p1"]
        );
        assert_eq!(
            first.items[0].content,
            text_document("current published body".into())
        );
        let second = single(&connection, query(first.next_cursor.clone())).unwrap();
        assert_eq!(second.items.len(), 6);
        assert!(!second.has_more);
        assert_eq!(second.items[0].history_id, "direct06");
        // Publishing a queued entry changes neither identity nor its original cursor.
        let cursor = first.items[3].cursor.clone();
        connection.execute("INSERT INTO conversation_message VALUES ('later','single','user',?1,'published later','2026-10-23T00:00:00Z')", [CURRENT_USER_ID]).unwrap();
        connection.execute("UPDATE single_chat_pending_input SET published_conversation_message_id='later', state='published' WHERE id='p1'", []).unwrap();
        let refreshed = single(&connection, query(None)).unwrap();
        assert_eq!(refreshed.items[3].history_id, "p1");
        assert_eq!(refreshed.items[3].cursor, cursor);
        assert_eq!(
            refreshed.items[3].content,
            text_document("published later".into())
        );
        assert!(
            single(
                &connection,
                SingleInputHistoryQuery {
                    conversation_id: "other".into(),
                    ..query(first.next_cursor)
                }
            )
            .is_err()
        );
    }
}
