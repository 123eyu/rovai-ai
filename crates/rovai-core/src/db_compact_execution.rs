//! Format 4 changes only future writes; old operation/body columns are not scanned or rebuilt.
use super::*;

pub(super) fn schema_matches(c: &Connection) -> rusqlite::Result<bool> {
    c.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('agent_run_execution_evidence')
        WHERE name='result_digest' AND type='TEXT') AND EXISTS(SELECT 1 FROM sqlite_master
        WHERE name='execution_evidence_storage_version_insert' AND instr(sql,'1,2,3,4')>0)",
        [],
        |r| r.get(0),
    )
}

fn route_formats(tx: &Connection, compact: bool) -> Result<()> {
    let view: String = tx.query_row(
        "SELECT sql FROM sqlite_master WHERE type='view' AND name='execution_activity'",
        [],
        |r| r.get(0),
    )?;
    let view = if compact {
        view.replace("storage_version=3", "storage_version IN (3,4)")
    } else {
        view.replace("storage_version IN (3,4)", "storage_version=3")
    };
    tx.execute_batch(
        "DROP VIEW execution_activity;
        DROP TRIGGER execution_evidence_storage_version_insert;
        DROP TRIGGER execution_activity_no_copy;",
    )?;
    tx.execute_batch(&view)?;
    let allowed = if compact { "1,2,3,4" } else { "1,2,3" };
    let unified = if compact {
        "storage_version IN (3,4)"
    } else {
        "storage_version=3"
    };
    tx.execute_batch(&format!("CREATE TRIGGER execution_evidence_storage_version_insert BEFORE INSERT ON agent_run_execution_evidence
        WHEN NEW.storage_version NOT IN ({allowed}) OR (NEW.storage_version>=2 AND
            (NEW.operation_id IS NULL OR NEW.input_preview_json IS NULL OR NEW.payload_preview_json <> '{{}}'))
        BEGIN SELECT RAISE(ABORT, 'invalid operation storage format'); END;
        CREATE TRIGGER execution_activity_no_copy BEFORE INSERT ON canonical_runtime_activity
        WHEN EXISTS(SELECT 1 FROM agent_run_execution_evidence WHERE agent_run_id=NEW.agent_run_id
            AND execution_epoch=NEW.execution_epoch AND operation_id=NEW.operation_id AND {unified})
        BEGIN SELECT RAISE(ABORT, 'unified operation cannot have an activity copy'); END;"))?;
    Ok(())
}

pub(super) fn migrate(db: &mut Database) -> Result<()> {
    let tx = db
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,DatabaseContractClassification::SupportedMigrationSource(ref m)
        if m.projection_schema_version==152),
        "Compact operation storage requires schema 152"
    );
    tx.execute_batch("ALTER TABLE agent_run_execution_evidence ADD COLUMN result_digest TEXT;")?;
    route_formats(&tx, true)?;
    tx.execute_batch("INSERT INTO schema_migration VALUES(203,datetime('now'));
        UPDATE rovai_data_contract SET projection_schema_version=153,updated_at=datetime('now') WHERE singleton=1;")?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::Current(_)
        ),
        "Compact storage admission failed"
    );
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub(super) fn downgrade_for_test(c: &Connection) {
    if !schema_matches(c).unwrap() {
        return;
    }
    route_formats(c, false).unwrap();
    c.execute_batch(
        "ALTER TABLE agent_run_execution_evidence DROP COLUMN result_digest;
        DELETE FROM schema_migration WHERE version=203;
        UPDATE rovai_data_contract SET projection_schema_version=152 WHERE singleton=1;",
    )
    .unwrap();
}

#[cfg(test)]
pub(super) fn assert_upgrade(db: &mut Database) {
    downgrade_for_test(db.connection());
    let snapshot = |c: &Connection| -> Vec<String> {
        c.prepare("SELECT json_array(id,payload_preview_json,input_preview_json,result_preview_json,
        input_blob_id,result_blob_id,storage_version,activity_meta_json) FROM agent_run_execution_evidence ORDER BY id").unwrap()
        .query_map([],|r|r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
    };
    let before = snapshot(db.connection());
    db.connection()
        .execute_batch(
            "CREATE TEMP TRIGGER reject_compact_receipt BEFORE INSERT ON schema_migration
        WHEN NEW.version=203 BEGIN SELECT RAISE(ABORT,'compact receipt rollback'); END;",
        )
        .unwrap();
    assert!(
        migrate(db)
            .unwrap_err()
            .to_string()
            .contains("compact receipt rollback")
    );
    assert_eq!(snapshot(db.connection()), before);
    assert!(!schema_matches(db.connection()).unwrap());
    db.connection()
        .execute_batch("DROP TRIGGER reject_compact_receipt;")
        .unwrap();
    migrate(db).unwrap();
    assert_eq!(snapshot(db.connection()), before);
    let c = Connection::open_with_flags(&db.path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    assert_eq!(snapshot(&c), before);
    assert!(matches!(
        classify_database_contract(&c).unwrap(),
        DatabaseContractClassification::Current(_)
    ));
}
