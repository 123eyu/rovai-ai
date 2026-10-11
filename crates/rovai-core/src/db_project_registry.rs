//! Only the directory ledger is new; initialization is a separate scoped operation.
use super::*;

pub(super) fn schema_matches(connection: &Connection) -> rusqlite::Result<bool> {
    let actual: Option<String> = connection.query_row(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='project_directory_registry'",
        [], |row| row.get(0),
    ).optional()?;
    let normalize = |sql: &str| sql.split_whitespace().collect::<String>();
    Ok(actual.as_deref().map(normalize) == Some(normalize(crate::project_registry::SCHEMA)))
}

pub(super) fn migrate(database: &mut Database) -> Result<()> {
    let tx = database
        .connection
        .transaction_with_behavior(TransactionBehavior::Immediate)?;
    anyhow::ensure!(
        matches!(classify_database_contract(&tx)?,
        DatabaseContractClassification::SupportedMigrationSource(ref marker)
        if marker.contract_version=="v1.72" && marker.projection_schema_version==140),
        "Project directory registry requires v1.72/schema 140"
    );
    tx.execute_batch(crate::project_registry::SCHEMA)?;
    tx.execute_batch("INSERT INTO schema_migration VALUES(191,datetime('now'));
        UPDATE rovai_data_contract SET projection_schema_version=141,updated_at=datetime('now') WHERE singleton=1;")?;
    anyhow::ensure!(
        matches!(
            classify_database_contract(&tx)?,
            DatabaseContractClassification::Current(_)
        ),
        "Project registry schema admission failed"
    );
    tx.commit()?;
    Ok(())
}

#[cfg(test)]
pub(super) fn downgrade_for_test(connection: &Connection) {
    if !connection
        .table_exists(None, "project_directory_registry")
        .unwrap()
    {
        return;
    }
    connection
        .execute_batch(
            "DROP TABLE project_directory_registry; DELETE FROM schema_migration WHERE version=191;
        UPDATE rovai_data_contract SET projection_schema_version=140 WHERE singleton=1;",
        )
        .unwrap();
}

#[cfg(all(test, feature = "extended-tests"))]
mod tests {
    use super::*;
    // Schema admission/rollback owner, independent of scoped legacy import.
    #[test]
    fn project_registry_schema_upgrade_is_atomic_and_does_not_complete_import() {
        let mut db = crate::test_support::seeded_runtime_database_owned();
        downgrade_for_test(db.connection());
        let before = public_history_claim_preserved_evidence_digest(db.connection()).unwrap();
        db.connection().execute_batch("CREATE TEMP TRIGGER reject_registry_migration BEFORE INSERT ON schema_migration WHEN NEW.version=191 BEGIN SELECT RAISE(ABORT,'fixture receipt failure'); END;").unwrap();
        assert!(migrate(&mut db).is_err());
        assert!(
            !db.connection()
                .table_exists(None, "project_directory_registry")
                .unwrap()
        );
        db.connection()
            .execute_batch("DROP TRIGGER reject_registry_migration")
            .unwrap();
        migrate(&mut db).unwrap();
        assert!(matches!(
            classify_database_contract(db.connection()).unwrap(),
            DatabaseContractClassification::Current(_)
        ));
        assert!(
            !crate::project_registry::snapshot(db.connection(), "desktop")
                .unwrap()
                .initialized
        );
        assert_eq!(
            public_history_claim_preserved_evidence_digest(db.connection()).unwrap(),
            before
        );
    }
}
