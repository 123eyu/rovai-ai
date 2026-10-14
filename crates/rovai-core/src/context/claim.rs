//! One claim snapshot owns both FIFO sizing and later input assembly.
use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BootstrapContents {
    pub session_charter: String,
    pub platform_skills: String,
    pub memory_entrypoint: String,
    pub observed_memory_revisions: Vec<Value>,
    pub authorization_basis_digest: String,
}

impl BootstrapContents {
    pub(super) fn read<R: ContextReadConnection>(
        database: &R,
        data_dir: &std::path::Path,
        snapshot: &RunSnapshot,
    ) -> Result<Self> {
        let connection = database.context_connection();
        let session_charter = build_session_charter(
            snapshot,
            camp_has_active_feishu_binding(connection, &snapshot.camp_id)?,
            mission_facts(connection, snapshot)?.is_some(),
        )?;
        let (memory_entrypoint, observed_memory_revisions, authorization_basis_digest) =
            if snapshot.invocation_kind == "single_chat" {
                (
                    String::new(),
                    Vec::new(),
                    canonical_json_digest(&json!({
                        "schemaVersion": 1, "memoryAccess": "none"
                    }))?,
                )
            } else {
                build_memory_entrypoint(database, snapshot)?
            };
        let managed = crate::managed_skills::ManagedSkills::for_data_dir(data_dir)?;
        managed.sync()?;
        let (entries, omitted) = managed.index(crate::managed_skills::PLATFORM_SKILLS);
        anyhow::ensure!(
            omitted.is_empty(),
            "platform Skill source is unavailable: {}",
            omitted.join("; ")
        );
        Ok(Self {
            session_charter,
            platform_skills: format!(
                "[ROVAI_PLATFORM_SKILLS]\n{}\n[/ROVAI_PLATFORM_SKILLS]",
                managed.index_json(&entries)?
            ),
            memory_entrypoint,
            observed_memory_revisions,
            authorization_basis_digest,
        })
    }

    fn payload(&self, member_identity: &MemberIdentityBootstrapProjection) -> Result<String> {
        render_session_bootstrap(
            &self.session_charter,
            member_identity,
            Some(&self.platform_skills),
            &self.memory_entrypoint,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClaimedBatchContext {
    pub(super) bootstrap: BootstrapContents,
    pub(super) member_identity: MemberIdentityBootstrapProjection,
    pub(super) collaboration_state: Value,
    pub(super) tasks: Vec<SelectedSelfActiveTask>,
    pub(super) omitted_tasks: usize,
    pub(super) run_facts: RenderedRunFacts,
    pub(super) mission_details_version: Option<i64>,
    pub(super) workspace: PreparedWorkspaceFact,
    pub(super) additional_skills: PreparedAdditionalSkills,
    pub(super) run_input: Value,
    had_native_session: bool,
    bootstrap_reserve: usize,
}

impl ClaimedBatchContext {
    pub(super) fn available_run_input(
        input: &Value,
        links: &[crate::current_input_skill::CurrentInputSkillLink],
    ) -> Value {
        let mut input = input.clone();
        if let Some(messages) = input.get_mut("messages").and_then(Value::as_array_mut) {
            for (index, message) in messages.iter_mut().enumerate() {
                if let Some(skills) = message.get_mut("skills").and_then(Value::as_array_mut) {
                    skills.retain(|skill| {
                        links.iter().any(|link| {
                            // v2 links are deduplicated by source ID. Their index/name
                            // describe the first mention; later messages retain their alias.
                            skill["path"].as_str() == Some(link.path.as_str())
                                && (link.skill_id.is_some()
                                    || (link
                                        .message_index
                                        .is_none_or(|message_index| message_index == index)
                                        && skill["name"].as_str() == Some(link.name.as_str())))
                        })
                    });
                    if skills.is_empty() {
                        message
                            .as_object_mut()
                            .expect("message projection is an object")
                            .remove("skills");
                    }
                }
            }
        }
        input
    }

    pub(crate) fn prepare(
        transaction: &Transaction<'_>,
        request: &DeliveryContextPreview<'_>,
        workspace_fact: Option<&Value>,
    ) -> Result<Self> {
        let snapshot = prospective_delivery_snapshot(transaction, request)?;
        let data_dir = std::path::Path::new(
            transaction
                .path()
                .context("Core database path is unavailable")?,
        )
        .parent()
        .context("Core data directory is unavailable")?;
        let bootstrap = BootstrapContents::read(transaction, data_dir, &snapshot)?;
        let member_identity = load_latest_member_identity(transaction, &snapshot.agent_id)?;
        let adapter = run_snapshot_adapter_kind(&snapshot)?;
        let may_redeliver = crate::compaction::release_default_policy(adapter)
            == crate::compaction::CompactionDetectorPolicy::BestEffort
            || has_pending_bootstrap_redelivery(transaction, &snapshot)?;
        // A resumed Session may need a new Bootstrap or be replaced after claim.
        // Reserve actual frozen bytes, never zero merely because an old digest exists.
        let bootstrap_reserve = if request.charter_delivery_mode
            == CharterDeliveryMode::FirstPayload
            || may_redeliver
        {
            render_bootstrap_redelivery_overlay(&bootstrap.payload(&member_identity)?).len() + 2
        } else {
            0
        };
        let members = load_collaboration_projection_members(transaction, &snapshot.camp_id)?;
        let (tasks, omitted_tasks) = load_self_active_tasks(
            transaction,
            &snapshot,
            current_public_camp_batch_context_delivery_profile()?.max_self_active_tasks,
        )?;
        let (facts, mission_details_version) = build_run_facts(transaction, &snapshot, false, 0)?;
        Ok(Self {
            bootstrap,
            member_identity,
            collaboration_state: build_collaboration_state(&members, &snapshot.agent_id),
            tasks,
            omitted_tasks,
            run_facts: render_run_facts(&facts)?,
            mission_details_version,
            workspace: match workspace_fact {
                Some(value) => PreparedWorkspaceFact {
                    value: Some(value.clone()),
                    digest: Some(canonical_json_digest(value)?),
                    included: true,
                },
                None => {
                    anyhow::ensure!(
                        mission_facts(transaction, &snapshot)?.is_none(),
                        "mission.workspace_not_prepared"
                    );
                    PreparedWorkspaceFact::default()
                }
            },
            additional_skills: prepare_additional_skills(transaction, data_dir, &snapshot)?,
            run_input: json!({"messages": []}),
            had_native_session: snapshot.native_session_id.is_some(),
            bootstrap_reserve,
        })
    }

    pub(crate) fn with_input(
        &self,
        transaction: &Transaction<'_>,
        request: &DeliveryContextPreview<'_>,
        run_input: Value,
        skills: &SkillSelectionSnapshot,
        previous_boundary: i64,
        additional_messages: bool,
    ) -> Result<Self> {
        let mut selected = self.clone();
        let mut snapshot = prospective_delivery_snapshot(transaction, request)?;
        snapshot.skill_selection_snapshot = skills.clone();
        selected.additional_skills = prepare_additional_skills(
            transaction,
            std::path::Path::new(
                transaction
                    .path()
                    .context("Core database path is unavailable")?,
            )
            .parent()
            .context("Core data directory is unavailable")?,
            &snapshot,
        )?;
        selected.run_input = run_input;
        let mut facts: Value = serde_json::from_str(&selected.run_facts.payload_json)?;
        facts["historyHint"] = json!(public_history_hint(previous_boundary, additional_messages));
        selected.run_facts.payload_json = serde_json::to_string(&facts)?;
        selected.run_facts.references.push(RunFactRef {
            fact: "history_hint".into(),
            task_id: None,
            mission_id: None,
        });
        while selected.payload_len()? > request.max_payload_bytes && !selected.tasks.is_empty() {
            selected.tasks.pop();
            selected.omitted_tasks += 1;
        }
        Ok(selected)
    }

    pub(crate) fn payload_len(&self) -> Result<usize> {
        let tasks = self_active_task_projection(&self.tasks, self.omitted_tasks);
        let facts = self.run_facts_for_session(true)?;
        let payload = render_payload(RenderPayloadInput {
            collaboration_state: Some(&self.collaboration_state),
            self_active_tasks: tasks.as_ref(),
            shared_conversation: None,
            run_facts: &facts,
            workspace: self.workspace.value.as_ref(),
            additional_skills: Some(&self.additional_skills.section),
            a2a_guidance: None,
            single_chat_guidance: None,
            current_input: None,
            run_input: Some(&self.run_input),
        })?;
        Ok(payload.len().saturating_add(self.bootstrap_reserve))
    }

    pub(super) fn run_facts_for_session(&self, new_session: bool) -> Result<RenderedRunFacts> {
        let mut facts = self.run_facts.clone();
        if new_session && self.had_native_session {
            let mut value: Value = serde_json::from_str(&facts.payload_json)?;
            value["sessionContinuity"] =
                json!({"state":"lost", "requiredAction":"recheck_private_session_assumptions"});
            facts.payload_json = serde_json::to_string(&value)?;
            facts.references.push(RunFactRef {
                fact: "session_continuity".into(),
                task_id: None,
                mission_id: None,
            });
        }
        Ok(facts)
    }

    pub(crate) fn persist(&self, transaction: &Transaction<'_>, run_id: &str) -> Result<()> {
        transaction.execute(
            "INSERT INTO agent_run_claim_context(agent_run_id, context_json) VALUES (?1, ?2)",
            params![run_id, serde_json::to_string(self)?],
        )?;
        Ok(())
    }
}

pub(super) fn load(connection: &Connection, run_id: &str) -> Result<Option<ClaimedBatchContext>> {
    // Historical inputs retain their original materializer, including databases
    // exercised at intermediate migration boundaries.
    let current: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_run_input WHERE agent_run_id=?1 AND context_manifest_version=36)",
        [run_id], |row| row.get(0),
    )?;
    if !current {
        return Ok(None);
    }
    let json: Option<String> = connection
        .query_row(
            "SELECT context_json FROM agent_run_claim_context WHERE agent_run_id=?1",
            [run_id],
            |row| row.get(0),
        )
        .optional()?;
    let json = json.context("Public batch is missing its claimed context")?;
    Ok(Some(
        serde_json::from_str(&json).context("Invalid claimed batch context")?,
    ))
}
