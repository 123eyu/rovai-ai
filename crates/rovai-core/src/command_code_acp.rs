//! Command Code's official stdio ACP profile. Fleet, routing, permissions,
//! replay and cancellation remain owned by the shared ACP Host.

use std::{fs, path::Path};

use anyhow::{Context, Result};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

pub const MINIMUM_VERSION: &str = "1.88.0";
pub const BOOTSTRAP_REVISION: &str = "command-code-system-bootstrap-v1";
const BOOTSTRAP: &str = include_str!("command_code/bootstrap.mjs");

/// 1.88.0 returns its complete native catalog in one page. Do not infer a
/// successful restore from resume/load: both silently accept missing history.
pub(crate) fn verify_restore_target(catalog: &Value, session_id: &str, cwd: &str) -> Result<()> {
    let sessions = catalog["sessions"]
        .as_array()
        .context("command_code_restore_catalog_invalid")?;
    if sessions.iter().any(|session| {
        session["sessionId"].as_str() == Some(session_id) && session["cwd"].as_str() == Some(cwd)
    }) {
        return Ok(());
    }
    anyhow::ensure!(
        catalog.get("nextCursor").is_none_or(Value::is_null)
            && sessions
                .iter()
                .all(|session| session["sessionId"].is_string() && session["cwd"].is_string()),
        "command_code_restore_catalog_incomplete"
    );
    // A future paginated catalog requires fresh qualification; absence from
    // an incomplete response cannot prove an exact restore of the old Session.
    Err(anyhow::anyhow!(
        "command_code_restore_target_missing: session not found in exact native catalog"
    )
    .context(crate::runtime::NativeSessionResumeFailure::Incompatible))
}

/// Native ACP sends the proposed edit only on tool_call. Its old/new strings
/// are matched fragments, not complete file states. Promote them only after a
/// matching successful terminal and never mislabel the proposal as a full diff.
pub fn enrich_tool_update(update: &mut Value, initial: Option<&Value>) {
    if let Some(meta) = update.get_mut("_meta").and_then(Value::as_object_mut) {
        meta.remove("rovaiCommandMutation");
    }
    if let Some(initial) = initial {
        for field in ["title", "kind", "rawInput", "locations"] {
            if update[field].is_null() && !initial[field].is_null() {
                update[field] = initial[field].clone();
            }
        }
    }
    // The official translator emits edit_file fragments as ACP diff content.
    // Remove them from the generic complete-before/after admission path.
    if let Some(content) = update.get_mut("content").and_then(Value::as_array_mut) {
        content.retain(|block| block["type"] != "diff");
    }
    if update["status"] != "completed" || initial.is_none_or(|value| value["kind"] != "edit") {
        return;
    }
    let input = &initial.expect("checked initial")["rawInput"];
    let path = input["file_path"]
        .as_str()
        .or_else(|| input["path"].as_str());
    let Some((path, old, new)) = path
        .zip(input["old_string"].as_str())
        .zip(input["new_string"].as_str())
        .map(|((p, o), n)| (p, o, n))
    else {
        return;
    };
    if path.trim().is_empty()
        || old.is_empty()
        || old == new
        || input["replace_all"] == true
        || input["replacement_count"].as_u64().is_some_and(|v| v != 1)
    {
        return;
    }
    let mutation = json!({"entries":[{"semantics":"reported_mutation", "path":path, "fragments":[{"oldText":old,"newText":new}]}]});
    if !update["_meta"].is_object() {
        update["_meta"] = json!({});
    }
    update["_meta"]["rovaiCommandMutation"] = mutation;
}

/// Deliver the official Mod in Host-owned temporary storage. Native HOME,
/// authentication, configuration and history remain entirely CLI-owned.
/// The returned nonce belongs only to the initialize handshake.
pub fn configure_host(command: &mut tokio::process::Command, root: &Path) -> Result<String> {
    fs::create_dir_all(root.join("bindings"))?;
    private_mode(&root.join("bindings"), 0o700)?;
    let plugin = root.join("rovai-bootstrap.mjs");
    write_private(&plugin, BOOTSTRAP.as_bytes())?;
    let nonce = uuid::Uuid::new_v4().to_string();
    command
        .arg("--mod")
        .arg(plugin)
        .env("COMMANDCODE_SKIP_UPDATES", "1")
        .env("ROVAI_COMMAND_CODE_BOOTSTRAP_ROOT", root)
        .env("ROVAI_COMMAND_CODE_BOOTSTRAP_NONCE", &nonce);
    Ok(nonce)
}

pub fn verify_ready(root: &Path, nonce: &str, expected_pid: u32) -> Result<()> {
    let path = root.join("ready.json");
    let ready: Value = serde_json::from_slice(
        &fs::read(&path)
            .context("Command Code Bootstrap extension did not load; no prompt sent")?,
    )?;
    anyhow::ensure!(
        ready["revision"] == BOOTSTRAP_REVISION
            && ready["nonce"] == nonce
            && expected_pid > 0
            && ready["pid"].as_u64() == Some(u64::from(expected_pid)),
        "command_code_bootstrap_readiness_invalid"
    );
    fs::remove_file(path)?;
    Ok(())
}

/// 1.88 applies native placeholder expansion even to ACP env/header pairs.
/// Escape once at this wire boundary so the server receives the resolved value;
/// native file serialization is not involved. ACP stdio also needs argv for cwd.
pub(crate) fn adapt_mcp_server(server: &mut Value, definition: &crate::mcp::McpServerDefinition) {
    for field in ["env", "headers"] {
        if let Some(pairs) = server.get_mut(field).and_then(Value::as_array_mut) {
            for pair in pairs {
                if let Some(value) = pair["value"].as_str() {
                    pair["value"] = json!(value.replace("${", "$${"));
                }
            }
        }
    }
    if let crate::mcp::McpServerDefinition::Stdio {
        command,
        args,
        cwd: Some(cwd),
        ..
    } = definition
    {
        server["command"] = json!("node");
        server["args"] = json!(
            [
                vec![
                    "--eval".to_owned(),
                    include_str!("command_code/mcp-cwd.cjs").to_owned(),
                    "--".to_owned(),
                    cwd.clone(),
                    command.clone()
                ],
                args.clone(),
            ]
            .concat()
        );
    }
}

pub fn bind_bootstrap(root: &Path, session_id: &str, bootstrap: &str) -> Result<()> {
    anyhow::ensure!(
        !session_id.is_empty()
            && session_id.len() <= 128
            && session_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !bootstrap.trim().is_empty()
            && bootstrap.len() <= crate::context::MAX_SESSION_BOOTSTRAP_BYTES,
        "command_code_bootstrap_binding_invalid"
    );
    let path = root.join("bindings").join(format!("{session_id}.json"));
    let payload = serde_json::to_vec(
        &json!({"schemaVersion":1, "sessionId":session_id, "bootstrap":bootstrap,
        "sha256":format!("{:x}",Sha256::digest(bootstrap.as_bytes()))}),
    )?;
    anyhow::ensure!(
        payload.len() <= 256 * 1024,
        "command_code_bootstrap_binding_invalid"
    );
    if path.exists() {
        anyhow::ensure!(
            fs::read(path)? == payload,
            "command_code_bootstrap_binding_changed"
        );
        return Ok(());
    }
    let temporary = root
        .join("bindings")
        .join(format!("{}.tmp", uuid::Uuid::new_v4()));
    write_private(&temporary, &payload)?;
    fs::rename(temporary, path)?;
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    fs::write(path, bytes)?;
    private_mode(path, 0o600)
}
fn private_mode(path: &Path, mode: u32) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}
pub fn supported_version(version: Option<&str>) -> bool {
    let Some(version) = version.and_then(|v| {
        v.split_whitespace()
            .find(|s| s.as_bytes().first().is_some_and(u8::is_ascii_digit))
    }) else {
        return false;
    };
    if version.contains('-') {
        return false;
    }
    version
        .split('+')
        .next()
        .unwrap_or(version)
        .split('.')
        .map(str::parse::<u64>)
        .collect::<std::result::Result<Vec<_>, _>>()
        .is_ok_and(|v| v.len() == 3 && v.as_slice() >= [1, 88, 0].as_slice())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_home_and_immutable_bootstrap_materials() {
        let root =
            std::env::temp_dir().join(format!("command-code-profile-{}", uuid::Uuid::new_v4()));
        let mut command = tokio::process::Command::new("command-code");
        command.env("HOME", root.join("user-home"));
        let nonce = configure_host(&mut command, &root).unwrap();
        assert_eq!(
            command
                .as_std()
                .get_envs()
                .find(|(k, _)| *k == "HOME")
                .unwrap()
                .1,
            Some(root.join("user-home").as_os_str())
        );
        assert!(!root.join("user-home").exists());
        assert!(!root.join("home").exists());
        assert!(!root.join("nonce").exists());
        assert_eq!(
            command.as_std().get_args().collect::<Vec<_>>(),
            vec![
                std::ffi::OsStr::new("--mod"),
                root.join("rovai-bootstrap.mjs").as_os_str()
            ]
        );
        let ready = root.join("ready.json");
        fs::write(
            &ready,
            serde_json::to_vec(&json!({"revision":BOOTSTRAP_REVISION,"nonce":nonce,"pid":123}))
                .unwrap(),
        )
        .unwrap();
        assert!(verify_ready(&root, "wrong", 123).is_err());
        assert!(verify_ready(&root, &nonce, 456).is_err());
        verify_ready(&root, &nonce, 123).unwrap();
        assert!(!ready.exists());
        bind_bootstrap(&root, "session-a", "frozen A").unwrap();
        let binding = root.join("bindings/session-a.json");
        let modified = fs::metadata(&binding).unwrap().modified().unwrap();
        bind_bootstrap(&root, "session-a", "frozen A").unwrap();
        assert_eq!(
            fs::metadata(&binding).unwrap().modified().unwrap(),
            modified
        );
        assert!(bind_bootstrap(&root, "session-a", "changed").is_err());
        bind_bootstrap(&root, "session-b", "frozen B").unwrap();
        assert_eq!(fs::read_dir(&root).unwrap().count(), 2);
        assert!(bind_bootstrap(&root, "../escape", "invalid").is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
