//! Client-scoped directory registration. Threads keep their existing path binding.
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Component, Path};

use crate::{
    command::{
        CommandEnvelope, CommandExecution, CommandHandlerResult, DomainCommand,
        DomainCommandGateway, sealed,
    },
    db::Database,
    draft_client::DraftClient,
};

// The empty path is a scope header, never a directory. Its revision also fences
// late snapshots and records initialization even for a successfully empty import.
pub(crate) const SCHEMA: &str = "CREATE TABLE project_directory_registry (
    scope TEXT NOT NULL,
    project_path TEXT NOT NULL,
    removed INTEGER NOT NULL CHECK(removed IN (0,1)),
    revision INTEGER NOT NULL CHECK(revision > 0),
    CHECK(project_path != '' OR removed = 0),
    PRIMARY KEY(scope, project_path)
)";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Directory {
    pub project_path: String,
    pub removed: bool,
    pub version: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub initialized: bool,
    pub revision: i64,
    pub projects: Vec<Directory>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScopeRequest {
    pub browser_scope_id: Option<String>,
}

pub fn scope(client: &DraftClient, browser_id: Option<&str>) -> Result<String> {
    if client.is_desktop() {
        ensure!(
            browser_id.is_none(),
            "Desktop cannot select a browser registry"
        );
        return Ok("desktop".into());
    }
    let id = browser_id.context("Browser project identity is required")?;
    ensure!(
        id.len() == 64 && id.bytes().all(|c| c.is_ascii_hexdigit()),
        "Invalid browser project identity"
    );
    Ok(format!("web:{}", id.to_ascii_lowercase()))
}

pub fn validate_path(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 8192 && !value.contains('\0'),
        "Invalid project path"
    );
    let path = Path::new(value);
    ensure!(
        path.is_absolute()
            && !path
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::CurDir)),
        "Project path must be normalized and absolute"
    );
    Ok(())
}

pub fn snapshot(connection: &Connection, scope: &str) -> Result<Snapshot> {
    let revision = connection
        .query_row(
            "SELECT revision FROM project_directory_registry WHERE scope=?1 AND project_path=''",
            [scope],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(0);
    let mut statement = connection.prepare(
        "SELECT project_path,removed,revision FROM project_directory_registry
         WHERE scope=?1 AND project_path!='' ORDER BY rowid",
    )?;
    let projects = statement
        .query_map([scope], |row| {
            Ok(Directory {
                project_path: row.get(0)?,
                removed: row.get(1)?,
                version: row.get(2)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(Snapshot {
        initialized: revision > 0,
        revision,
        projects,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InitializeRequest {
    pub browser_scope_id: Option<String>,
    pub project_paths: Vec<String>,
    pub removed_paths: Vec<String>,
}

pub fn initialize(
    database: &mut Database,
    scope: &str,
    client: &DraftClient,
    input: &InitializeRequest,
) -> Result<Snapshot> {
    let tx = database.connection_mut().transaction()?;
    if !snapshot(&tx, scope)?.initialized {
        for path in input.project_paths.iter().chain(&input.removed_paths) {
            validate_path(path)?;
        }
        // Complete metadata query in this transaction, never a paged Renderer window.
        let paths = crate::read_model::navigation_project_paths(&tx, client)?;
        tx.execute(
            "INSERT INTO project_directory_registry VALUES(?1,'',0,1)",
            [scope],
        )?;
        // Removal wins over legacy order, pins, selected directory and Core groups.
        for path in &input.removed_paths {
            insert_missing(&tx, scope, path, true)?;
        }
        for path in paths.iter().chain(&input.project_paths) {
            insert_missing(&tx, scope, path, false)?;
        }
        if scope == "desktop" {
            synchronize_desktop_access(&tx)?;
        }
    }
    let result = snapshot(&tx, scope)?;
    tx.commit()?;
    Ok(result)
}

fn insert_missing(tx: &Transaction<'_>, scope: &str, path: &str, removed: bool) -> Result<bool> {
    validate_path(path)?;
    Ok(tx.execute(
        "INSERT OR IGNORE INTO project_directory_registry VALUES(?1,?2,?3,1)",
        params![scope, path, removed],
    )? != 0)
}

/// Only a registry-local constraint failure is eligible for optional-write
/// degradation. Busy/I/O/full/corruption/authorization/schema errors retain their
/// normal failure semantics. Even a constraint may ROLLBACK the outer transaction.
#[derive(Debug)]
pub struct Unavailable;
impl std::fmt::Display for Unavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Project directory registration is temporarily unavailable"
        )
    }
}
impl std::error::Error for Unavailable {}

fn isolated_constraint(error: &anyhow::Error) -> bool {
    matches!(error.downcast_ref::<rusqlite::Error>(),
        Some(rusqlite::Error::SqliteFailure(code, _)) if code.code == rusqlite::ErrorCode::ConstraintViolation)
}
fn registration_error(error: rusqlite::Error) -> anyhow::Error {
    let error = anyhow::Error::from(error);
    if isolated_constraint(&error) {
        error.context(Unavailable)
    } else {
        error
    }
}

/// Registration is auxiliary to the business transaction. A savepoint rolls back
/// ALL registry scopes together, while the gateway still commits business rows,
/// events and the receipt atomically. Tombstones are never restored here.
pub(crate) fn register_introduced(tx: &Transaction<'_>, path: &str) -> Result<()> {
    validate_path(path)?;
    ensure!(!tx.is_autocommit(), "Business transaction is not active");
    tx.execute_batch("SAVEPOINT introduced_project")?;
    let registration = (|| -> Result<()> {
        let mut query =
            tx.prepare("SELECT scope FROM project_directory_registry WHERE project_path=''")?;
        let scopes = query
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for scope in scopes {
            if insert_missing(tx, &scope, path, false)? {
                advance(tx, &scope)?;
            }
        }
        Ok(())
    })();
    match registration {
        Ok(()) => {
            tx.execute_batch("RELEASE introduced_project")?;
            Ok(())
        }
        Err(error) => {
            // RAISE(ROLLBACK), SQLITE_FULL and some I/O errors can already have
            // aborted the enclosing transaction. Never continue in autocommit.
            if tx.is_autocommit() || !isolated_constraint(&error) {
                return Err(error);
            }
            tx.execute_batch("ROLLBACK TO introduced_project; RELEASE introduced_project")?;
            ensure!(
                !tx.is_autocommit(),
                "Business transaction was lost during project registration"
            );
            eprintln!("project registration deferred; business transaction retained: {error:#}");
            Ok(())
        }
    }
}

fn advance(tx: &Transaction<'_>, scope: &str) -> Result<()> {
    tx.execute("UPDATE project_directory_registry SET revision=revision+1 WHERE scope=?1 AND project_path=''", [scope])?;
    Ok(())
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetDirectory {
    #[serde(default, skip_deserializing)]
    pub scope: String,
    pub project_path: String,
    pub removed: bool,
    pub expected_version: i64,
}
impl sealed::Sealed for SetDirectory {}
impl DomainCommand for SetDirectory {
    const TYPE: &'static str = "projects.set";
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetRequest {
    pub browser_scope_id: Option<String>,
    pub command_id: String,
    pub command: SetDirectory,
}

pub fn set(
    database: &mut Database,
    envelope: &CommandEnvelope<SetDirectory>,
) -> Result<CommandExecution> {
    DomainCommandGateway.execute(database, envelope, |tx| {
        let input = &envelope.payload;
        validate_path(&input.project_path)?;
        let before = snapshot(tx, &input.scope)?;
        if !before.initialized {
            return Ok(CommandHandlerResult::rejected("projects.not_initialized", json!({"message":"项目目录尚未初始化，请重试。"})));
        }
        let current = before.projects.iter().find(|p| p.project_path == input.project_path);
        let version = current.map_or(0, |p| p.version);
        // An already satisfied target is a no-op even with an old version. A
        // stale ADD facing a newer removal still reaches the conflict check.
        if current.is_some_and(|p| p.removed == input.removed) {
            return Ok(CommandHandlerResult::applied("projects.unchanged", serde_json::to_value(before)?, None));
        }
        if input.expected_version != version {
            return Ok(CommandHandlerResult::rejected("projects.version_conflict", json!({"message":"项目状态已变化，请重新操作。"})));
        }
        if !input.removed {
            // Explicit add/restore validates once. Reads/imports never touch the filesystem.
            let canonical = crate::runtime_discovery::runtime_visible_path(
                std::fs::canonicalize(&input.project_path).context("项目目录暂不可访问，请检查路径后重试。")?,
            );
            ensure!(canonical.is_dir() && canonical.to_string_lossy() == input.project_path, "项目目录已变化，请重新选择目录。");
        }
        tx.execute("INSERT INTO project_directory_registry VALUES(?1,?2,?3,1)
            ON CONFLICT(scope,project_path) DO UPDATE SET removed=excluded.removed,revision=revision+1",
            params![input.scope, input.project_path, input.removed]).map_err(registration_error)?;
        advance(tx, &input.scope).map_err(|error| if isolated_constraint(&error) { error.context(Unavailable) } else { error })?;
        if input.scope == "desktop" {
            synchronize_desktop_access(tx)?;
            if input.removed {
                tx.execute("UPDATE skill_projection_root_state SET dirty=EXISTS(SELECT 1 FROM skill_projection_observation WHERE execution_root=?1),cleanup_required=EXISTS(SELECT 1 FROM skill_projection_observation WHERE execution_root=?1) WHERE execution_root=?1", [&input.project_path])?;
            }
        }
        Ok(CommandHandlerResult::applied("projects.saved", serde_json::to_value(snapshot(tx, &input.scope)?)?, None))
    })
}

/// Preserve Desktop's existing Skill access projection. Browser-local removal
/// has no Host-wide access effect. Registration remains the only source.
pub(crate) fn synchronize_desktop_access(tx: &Transaction<'_>) -> Result<()> {
    tx.execute(
        "UPDATE skill_projection_root_state SET access_state='active',dirty=1,
        cleanup_required=0,removed_at=NULL,updated_at=datetime('now')
        WHERE access_state='removed' AND NOT EXISTS(
            SELECT 1 FROM project_directory_registry p WHERE p.scope='desktop'
            AND p.project_path=execution_root AND p.removed=1)",
        [],
    )?;
    tx.execute("INSERT INTO skill_projection_root_state(execution_root,access_state,dirty,cleanup_required,removed_at,updated_at)
        SELECT project_path,'removed',0,0,datetime('now'),datetime('now')
        FROM project_directory_registry WHERE scope='desktop' AND removed=1
        ON CONFLICT(execution_root) DO UPDATE SET access_state='removed',
            removed_at=COALESCE(skill_projection_root_state.removed_at,excluded.removed_at),updated_at=excluded.updated_at", [])?;
    Ok(())
}

pub fn restore_desktop_access(database: &mut Database) -> Result<()> {
    let tx = database.connection_mut().transaction()?;
    if snapshot(&tx, "desktop")?.initialized {
        synchronize_desktop_access(&tx)?;
    }
    tx.commit()?;
    Ok(())
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;
    use crate::command::{ActorRef, CommandResultStatus};

    fn user_command<C>(payload: C, camp_id: Option<String>) -> CommandEnvelope<C> {
        CommandEnvelope {
            command_id: uuid::Uuid::new_v4().to_string(),
            actor: ActorRef::User {
                user_id: "local_user".into(),
            },
            camp_id,
            execution_epoch: None,
            expected_versions: vec![],
            payload,
        }
    }

    fn envelope(
        path: &str,
        removed: bool,
        version: i64,
        scope: &str,
    ) -> CommandEnvelope<SetDirectory> {
        CommandEnvelope {
            command_id: uuid::Uuid::new_v4().to_string(),
            actor: ActorRef::User {
                user_id: "local_user".into(),
            },
            camp_id: None,
            execution_epoch: None,
            expected_versions: vec![],
            payload: SetDirectory {
                scope: scope.into(),
                project_path: path.into(),
                removed,
                expected_version: version,
            },
        }
    }
    fn init(
        db: &mut Database,
        scope: &str,
        projects: Vec<String>,
        removed: Vec<String>,
    ) -> Snapshot {
        initialize(
            db,
            scope,
            &DraftClient::default(),
            &InitializeRequest {
                browser_scope_id: None,
                project_paths: projects,
                removed_paths: removed,
            },
        )
        .unwrap()
    }

    // Persistence/scope/receipt owner. A pure projection test cannot prove that
    // empty registrations and tombstones survive reopening the production DB.
    #[test]
    fn empty_projects_and_removal_survive_threads_replay_and_restart() {
        let (mut db, directory) = crate::test_support::seeded_runtime_database();
        let root = directory.canonicalize().unwrap();
        let a = root.join("a");
        let b = root.join("b");
        std::fs::create_dir(&a).unwrap();
        std::fs::create_dir(&b).unwrap();
        let a = a.to_str().unwrap();
        let b = b.to_str().unwrap();
        let browser = scope(
            &DraftClient::verified_web(&"a".repeat(64)).unwrap(),
            Some(&"b".repeat(64)),
        )
        .unwrap();
        assert!(scope(&DraftClient::default(), Some(&"b".repeat(64))).is_err());
        assert!(scope(&DraftClient::verified_web(&"a".repeat(64)).unwrap(), None).is_err());
        init(&mut db, "desktop", vec![], vec![]);
        init(&mut db, &browser, vec![], vec![]);
        let add_a = envelope(a, false, 0, "desktop");
        for cmd in [&add_a, &envelope(b, false, 0, "desktop")] {
            assert_eq!(
                set(&mut db, cmd).unwrap().result.status,
                CommandResultStatus::Applied
            );
        }
        assert!(
            snapshot(db.connection(), &browser)
                .unwrap()
                .projects
                .is_empty()
        );
        assert_eq!(
            set(&mut db, &envelope(a, false, 0, "desktop"))
                .unwrap()
                .result
                .code,
            "projects.unchanged"
        );
        let service = crate::collaboration::CollaborationService::default();
        let create_thread = |db: &mut Database, path: &str| {
            let created = service
                .create_camp(
                    db,
                    &user_command(
                        crate::collaboration::CreateThreadCommand::for_test(path.into()),
                        None,
                    ),
                )
                .unwrap();
            assert_eq!(created.result.status, CommandResultStatus::Applied);
            created.result.payload["threadId"]
                .as_str()
                .unwrap()
                .to_string()
        };
        let first = create_thread(&mut db, a);
        let version = db
            .connection()
            .query_row("SELECT version FROM camp WHERE id=?1", [&first], |r| {
                r.get(0)
            })
            .unwrap();
        let deleted = service
            .delete_camp(
                &mut db,
                &user_command(
                    crate::collaboration::DeleteThreadCommand {
                        camp_id: first.clone(),
                        expected_version: version,
                        force: false,
                        workspace_disposition: Default::default(),
                    },
                    Some(first),
                ),
            )
            .unwrap();
        assert_eq!(deleted.result.code, "camp.deleted");
        assert_eq!(
            snapshot(db.connection(), "desktop").unwrap().projects.len(),
            2
        );
        // Remove a project that still contains a Thread. Neither object is deleted.
        let remaining = create_thread(&mut db, b);
        assert_eq!(
            snapshot(db.connection(), &browser).unwrap().projects.len(),
            2
        );
        let remove_b = envelope(b, true, 1, "desktop");
        assert_eq!(
            set(&mut db, &remove_b).unwrap().result.status,
            CommandResultStatus::Applied
        );
        assert!(set(&mut db, &remove_b).unwrap().replayed);
        // Old operation (different command id) and old initialization cannot restore it.
        assert_eq!(
            set(&mut db, &envelope(b, false, 1, "desktop"))
                .unwrap()
                .result
                .code,
            "projects.version_conflict"
        );
        init(&mut db, "desktop", vec![b.into()], vec![]);
        let tx = db.connection_mut().transaction().unwrap();
        register_introduced(&tx, b).unwrap();
        tx.commit().unwrap();
        assert!(
            snapshot(db.connection(), "desktop")
                .unwrap()
                .projects
                .iter()
                .find(|p| p.project_path == b)
                .unwrap()
                .removed
        );
        assert!(
            !snapshot(db.connection(), &browser)
                .unwrap()
                .projects
                .iter()
                .find(|p| p.project_path == b)
                .unwrap()
                .removed
        );
        assert!(set(&mut db, &add_a).unwrap().replayed);
        drop(db);
        let mut db = Database::open(&directory).unwrap();
        let before = snapshot(db.connection(), "desktop").unwrap();
        assert_eq!(before.projects.len(), 2);
        assert_eq!(before.projects.iter().filter(|p| !p.removed).count(), 1);
        assert!(Path::new(b).is_dir());
        assert_eq!(
            db.connection()
                .query_row("SELECT count(*) FROM camp WHERE id=?1", [&remaining], |r| r
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            set(&mut db, &envelope(b, false, 2, "desktop"))
                .unwrap()
                .result
                .status,
            CommandResultStatus::Applied
        );
        assert_eq!(
            snapshot(db.connection(), "desktop").unwrap().projects.len(),
            2
        );
        assert!(
            !crate::skill_projection::SkillProjectionReconciler
                .execution_root_is_removed(&db, b)
                .unwrap()
        );
        drop(db);
        std::fs::remove_dir_all(directory).unwrap();
    }

    // Owns initialization transaction rollback and no empty-default replacement.
    #[test]
    fn initialization_and_writes_fail_closed_and_offline_records_remain() {
        let (mut db, directory) = crate::test_support::seeded_runtime_database();
        db.connection().execute("INSERT INTO camp(id,title,project_binding_kind,project_path,created_at,updated_at) VALUES('legacy','legacy','directory','/old-visible','2026-10-11','2026-10-11')", []).unwrap();
        db.connection().execute_batch("CREATE TEMP TRIGGER reject_registry BEFORE INSERT ON project_directory_registry WHEN NEW.project_path='/old-visible' BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;").unwrap();
        let input = InitializeRequest {
            browser_scope_id: None,
            project_paths: vec!["/old-empty".into()],
            removed_paths: vec!["/old-visible".into()],
        };
        assert!(initialize(&mut db, "desktop", &DraftClient::default(), &input).is_err());
        assert!(!snapshot(db.connection(), "desktop").unwrap().initialized);
        db.connection()
            .execute_batch("DROP TRIGGER reject_registry")
            .unwrap();
        let first = initialize(&mut db, "desktop", &DraftClient::default(), &input).unwrap();
        assert_eq!(first.projects.len(), 2);
        assert!(
            first
                .projects
                .iter()
                .find(|p| p.project_path == "/old-visible")
                .unwrap()
                .removed
        );
        // A temporarily absent filesystem directory remains readable/removable;
        // restoring it requires successful access validation and cannot lose the tombstone.
        assert_eq!(
            set(&mut db, &envelope("/old-empty", true, 1, "desktop"))
                .unwrap()
                .result
                .status,
            CommandResultStatus::Applied
        );
        assert!(set(&mut db, &envelope("/old-empty", false, 2, "desktop")).is_err());
        let revision = snapshot(db.connection(), "desktop").unwrap().revision;
        db.connection().execute_batch("CREATE TEMP TRIGGER reject_registry_update BEFORE UPDATE ON project_directory_registry BEGIN SELECT RAISE(ABORT,'fixture disk failure'); END;").unwrap();
        assert!(set(&mut db, &envelope("/another-offline", true, 0, "desktop")).is_err());
        let after = snapshot(db.connection(), "desktop").unwrap();
        assert_eq!(after.revision, revision);
        assert_eq!(after.projects.len(), 2);
        db.connection()
            .authorizer(Some(|ctx: rusqlite::hooks::AuthContext<'_>| {
                if matches!(
                    ctx.action,
                    rusqlite::hooks::AuthAction::Read {
                        table_name: "camp",
                        ..
                    }
                ) {
                    rusqlite::hooks::Authorization::Deny
                } else {
                    rusqlite::hooks::Authorization::Allow
                }
            }))
            .unwrap();
        assert!(initialize(&mut db, "web:read-failure", &DraftClient::default(), &input).is_err());
        db.connection()
            .authorizer(
                None::<fn(rusqlite::hooks::AuthContext<'_>) -> rusqlite::hooks::Authorization>,
            )
            .unwrap();
        assert!(
            !snapshot(db.connection(), "web:read-failure")
                .unwrap()
                .initialized
        );
        assert_eq!(
            snapshot(db.connection(), "desktop").unwrap().projects.len(),
            2
        );
        db.connection()
            .execute_batch("DROP TRIGGER reject_registry_update")
            .unwrap();
        // The requesting UI saves its directory before creating a Thread.
        // A failed creation keeps that entry without leaking it to other scopes.
        init(&mut db, "web:other", vec![], vec![]);
        let failed_path =
            crate::runtime_discovery::runtime_visible_path(directory.canonicalize().unwrap());
        let failed_path = failed_path.to_str().unwrap();
        assert_eq!(
            set(&mut db, &envelope(failed_path, false, 0, "desktop"))
                .unwrap()
                .result
                .status,
            CommandResultStatus::Applied
        );
        let command = crate::collaboration::CreateThreadCommand::for_test_with_members(
            failed_path.into(),
            &[],
            "agent_1",
        );
        let result = crate::collaboration::CollaborationService::default()
            .create_camp(
                &mut db,
                &CommandEnvelope {
                    command_id: uuid::Uuid::new_v4().to_string(),
                    actor: ActorRef::User {
                        user_id: "local_user".into(),
                    },
                    camp_id: None,
                    execution_epoch: None,
                    expected_versions: vec![],
                    payload: command,
                },
            )
            .unwrap();
        assert_eq!(result.result.status, CommandResultStatus::Rejected);
        assert!(
            snapshot(db.connection(), "desktop")
                .unwrap()
                .projects
                .iter()
                .any(|p| p.project_path == failed_path && !p.removed)
        );
        assert!(
            !snapshot(db.connection(), "web:other")
                .unwrap()
                .projects
                .iter()
                .any(|p| p.project_path == failed_path)
        );
        drop(db);
        std::fs::remove_dir_all(directory).unwrap();
    }
    // Owns auxiliary-write isolation at the real CommandGateway boundary. Pure
    // mocks cannot prove savepoint recovery, outer rollback, or commit failure.
    #[test]
    fn optional_registration_cannot_block_business_or_mask_a_lost_transaction() {
        use crate::collaboration::{
            CollaborationService, CreateThreadCommand, TestThreadMessageAddress,
            TestThreadMessageCommand, ThreadActivationState,
        };
        let (mut db, directory) = crate::test_support::seeded_runtime_database();
        init(&mut db, "desktop", vec![], vec![]);
        init(&mut db, "web:test", vec![], vec![]);
        let path =
            crate::runtime_discovery::runtime_visible_path(directory.canonicalize().unwrap());
        let path = path.to_str().unwrap();
        let service = CollaborationService::default();
        let count = |db: &Database, table: &str| -> i64 {
            db.connection()
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap()
        };
        for fault in ["ABORT", "ROLLBACK", "COMMIT"] {
            // Fail the second scope, after the first registry write has happened.
            db.connection().execute_batch(&format!("CREATE TEMP TRIGGER registry_failure BEFORE INSERT ON project_directory_registry WHEN NEW.scope='web:test' AND NEW.project_path!='' BEGIN SELECT RAISE({},'registry-only failure'); END;", if fault == "COMMIT" { "ABORT" } else { fault })).unwrap();
            for pending in [false, true] {
                let mut command = CreateThreadCommand::for_test(path.into());
                if pending {
                    command.activation_state = ThreadActivationState::Pending;
                }
                let create = user_command(command, None);
                let before_camps = count(&db, "camp");
                let mut camp_id = None;
                let mut send = None;
                if pending {
                    let created = service.create_camp(&mut db, &create).unwrap();
                    let id = created.result.payload["threadId"]
                        .as_str()
                        .unwrap()
                        .to_owned();
                    let draft = crate::camp_attachment::ThreadAttachmentStore::new(&directory)
                        .save_body(&mut db, &id, "preserve this input")
                        .unwrap();
                    send = Some(user_command(
                        TestThreadMessageCommand {
                            camp_id: id.clone(),
                            draft_revision: Some(draft.revision),
                            body: String::new(),
                            prepared_attachment_ids: vec![],
                            address: TestThreadMessageAddress::Default,
                            reply_to_camp_message_id: None,
                            execution: None,
                        },
                        Some(id.clone()),
                    ));
                    camp_id = Some(id);
                }
                let before_messages = count(&db, "camp_message");
                let before_events = count(&db, "event_log");
                if fault == "COMMIT" {
                    db.connection().commit_hook(Some(|| true)).unwrap();
                }
                let result = if let Some(send) = &send {
                    service.send_test_camp_message(&mut db, send)
                } else {
                    service.create_camp(&mut db, &create)
                };
                db.connection().commit_hook(None::<fn() -> bool>).unwrap();
                if fault == "ABORT" {
                    assert_eq!(result.unwrap().result.status, CommandResultStatus::Applied);
                    let events = count(&db, "event_log");
                    let replay = if let Some(send) = &send {
                        service.send_test_camp_message(&mut db, send)
                    } else {
                        service.create_camp(&mut db, &create)
                    }
                    .unwrap();
                    assert!(replay.replayed);
                    assert_eq!(count(&db, "event_log"), events);
                    assert_eq!(count(&db, "camp"), before_camps + 1);
                    assert_eq!(
                        count(&db, "camp_message"),
                        before_messages + i64::from(pending)
                    );
                } else {
                    assert!(result.is_err(), "{fault}: cannot report business success");
                    assert_eq!(count(&db, "camp"), before_camps + i64::from(pending));
                    assert_eq!(count(&db, "camp_message"), before_messages);
                    assert_eq!(count(&db, "event_log"), before_events);
                    if let Some(id) = camp_id {
                        assert_eq!(
                            db.connection()
                                .query_row(
                                    "SELECT activation_state FROM camp WHERE id=?1",
                                    [&id],
                                    |r| r.get::<_, String>(0)
                                )
                                .unwrap(),
                            "pending"
                        );
                        assert_eq!(
                            db.connection()
                                .query_row(
                                    "SELECT body FROM camp_composer_draft WHERE camp_id=?1",
                                    [&id],
                                    |r| r.get::<_, String>(0)
                                )
                                .unwrap(),
                            "preserve this input"
                        );
                    }
                }
                assert!(
                    snapshot(db.connection(), "desktop")
                        .unwrap()
                        .projects
                        .is_empty()
                );
                assert!(
                    snapshot(db.connection(), "web:test")
                        .unwrap()
                        .projects
                        .is_empty()
                );
            }
            db.connection()
                .execute_batch("DROP TRIGGER registry_failure")
                .unwrap();
        }
        // Never open an independent savepoint/transaction after an outer abort.
        let tx = db.connection_mut().transaction().unwrap();
        tx.execute_batch("ROLLBACK").unwrap();
        assert!(register_introduced(&tx, path).is_err());
        assert!(tx.is_autocommit());
        drop(tx);
        // Recovery fills missing records without replacing a scope's removal.
        set(&mut db, &envelope(path, true, 0, "desktop")).unwrap();
        let tx = db.connection_mut().transaction().unwrap();
        register_introduced(&tx, path).unwrap();
        tx.commit().unwrap();
        assert!(snapshot(db.connection(), "desktop").unwrap().projects[0].removed);
        assert!(!snapshot(db.connection(), "web:test").unwrap().projects[0].removed);
        // Access/DB errors are never converted to optional registration success.
        db.connection()
            .authorizer(Some(|ctx: rusqlite::hooks::AuthContext<'_>| {
                if matches!(
                    ctx.action,
                    rusqlite::hooks::AuthAction::Read {
                        table_name: "project_directory_registry",
                        ..
                    }
                ) {
                    rusqlite::hooks::Authorization::Deny
                } else {
                    rusqlite::hooks::Authorization::Allow
                }
            }))
            .unwrap();
        assert!(
            service
                .create_camp(
                    &mut db,
                    &user_command(CreateThreadCommand::for_test(path.into()), None)
                )
                .is_err()
        );
        db.connection()
            .authorizer(
                None::<fn(rusqlite::hooks::AuthContext<'_>) -> rusqlite::hooks::Authorization>,
            )
            .unwrap();
        drop(db);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
