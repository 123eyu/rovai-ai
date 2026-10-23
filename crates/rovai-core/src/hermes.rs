//! Versioned, process-owned entry into the official Hermes ACP implementation.
//! Native authentication, model resolution, tools and session storage stay native.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::Command;

use crate::{agent_profile::AdapterKind, command::canonical_json_digest};

pub const REVISION: &str = "rovai-hermes-host-v3";
const HOST: &str = include_str!("hermes/host.py");
const NATIVE_ENTRY: &str =
    "runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)";

pub fn supported_version(version: Option<&str>) -> bool {
    version
        .and_then(crate::agent_runtime_adapter::parse_reported_runtime_version)
        .is_some_and(|(version, _)| version >= [0, 22, 4])
}

pub fn native_home() -> Result<PathBuf> {
    let home = crate::runtime_discovery::runtime_environment_variable(
        AdapterKind::HermesCli,
        "HERMES_HOME",
    )
    .filter(|value| !value.is_empty())
    .map(PathBuf::from)
    .or_else(|| {
        crate::runtime_discovery::runtime_home_directory(AdapterKind::HermesCli)
            .map(|home| home.join(".hermes"))
    })
    .context("Hermes native Home unavailable")?;
    ensure!(home.is_absolute(), "Hermes Home must be absolute");
    Ok(home)
}

pub fn native_configuration_digest() -> Result<String> {
    let home = native_home()?;
    let mut inputs = vec![
        json!({"revision": REVISION, "host": format!("{:x}", Sha256::digest(HOST)), "home": home}),
    ];
    for name in [
        "config.yaml",
        ".env",
        "auth.json",
        "hermes-agent/install-stamp.json",
    ] {
        let digest = match fs::read(home.join(name)) {
            Ok(bytes) => Some(format!("{:x}", Sha256::digest(bytes))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => anyhow::bail!("hermes_native_configuration_unreadable"),
        };
        inputs.push(json!({"name": name, "sha256": digest}));
    }
    canonical_json_digest(&json!(inputs))
}

fn managed_argv(mut argv: Vec<String>, script: &Path) -> Result<Vec<String>> {
    ensure!(
        argv.len() == 4
            && Path::new(&argv[0]).is_absolute()
            && argv[1] == "-I"
            && argv[2] == "-c"
            && argv[3].ends_with(NATIVE_ENTRY),
        "Hermes installation-bound launcher is unsupported; install official Hermes >= 0.22.4"
    );
    let prefix_len = argv[3].len() - NATIVE_ENTRY.len();
    argv[3].truncate(prefix_len);
    argv[3].push_str("runpy.run_path(sys.argv[1], run_name='__main__')");
    argv.push(
        script
            .to_str()
            .context("Hermes host path is not UTF-8")?
            .to_owned(),
    );
    Ok(argv)
}

/// Resolve through the selected launcher's official machine boundary. No shell
/// parsing, interpreter search or dependency installation. The controller starts
/// unmodified official CLI children in a binding-scoped private native Home.
pub async fn configure_command(
    command: &mut Command,
    root: &Path,
    storage: &Path,
    bootstrap: Option<&str>,
) -> Result<()> {
    let native = command.as_std();
    let launcher = native.get_program().to_owned();
    ensure!(
        native.get_args().next().is_none(),
        "Hermes entry must be configured before arguments"
    );
    let environment: Vec<_> = native
        .get_envs()
        .map(|(k, v)| (k.to_owned(), v.map(ToOwned::to_owned)))
        .collect();
    let cwd = native.get_current_dir().map(ToOwned::to_owned);
    let mut resolver = Command::new(native.get_program());
    resolver
        .arg("--print-runtime-command")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    for (key, value) in &environment {
        if let Some(value) = value {
            resolver.env(key, value);
        } else {
            resolver.env_remove(key);
        }
    }
    resolver.env("HERMES_DISABLE_LAZY_INSTALLS", "1");
    if let Some(cwd) = &cwd {
        resolver.current_dir(cwd);
    }
    let output = crate::runtime_probe_process::run_bounded_command(
        &mut resolver,
        crate::runtime_probe_process::ProbeCommandLimits::new(Duration::from_secs(30)),
    )
    .await
    .context("Hermes launcher resolution failed")?;
    ensure!(
        output.status.success() && !output.stdout.truncated,
        "Hermes launcher resolution failed"
    );
    let argv: Vec<String> = serde_json::from_slice(&output.stdout.bytes)
        .context("Hermes launcher response is invalid")?;
    let root = crate::platform::private_storage::prepare_private_directory(root)?;
    let script = root.join("host.py");
    fs::write(&script, HOST)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&script, fs::Permissions::from_mode(0o600))?;
    }
    let argv = managed_argv(argv, &script)?;
    let mut managed = Command::new(&argv[0]);
    managed.args(&argv[1..]);
    for (key, value) in environment {
        if let Some(value) = value {
            managed.env(key, value);
        } else {
            managed.env_remove(key);
        }
    }
    if let Some(cwd) = cwd {
        managed.current_dir(cwd);
    }
    let storage = crate::platform::private_storage::prepare_private_directory(storage)?;
    managed.env("ROVAI_HERMES_LAUNCHER", launcher);
    managed.env("HERMES_DISABLE_LAZY_INSTALLS", "1");
    managed.env("ROVAI_HERMES_STORAGE", storage);
    if let Some(bootstrap) = bootstrap {
        let path = root.join("bootstrap.txt");
        fs::write(&path, bootstrap)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        }
        managed.env("ROVAI_HERMES_BOOTSTRAP_FILE", path);
    } else {
        managed.env_remove("ROVAI_HERMES_BOOTSTRAP_FILE");
    }
    *command = managed;
    Ok(())
}

pub fn validate_ready(value: &Value, pid: Option<u32>) -> Result<()> {
    ensure!(
        value["revision"] == REVISION
            && supported_version(value["version"].as_str())
            && pid.is_some_and(|pid| value["pid"] == pid),
        "Hermes managed host identity mismatch"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Owns the new internal-API boundary. Existing ACP transport tests cannot
    // detect substitution of the installation's bootstrap or another process.
    #[test]
    fn managed_entry_requires_the_known_native_launcher_and_execution_identity() {
        let argv = vec![
            "/native/python".into(),
            "-I".into(),
            "-c".into(),
            format!("import runpy; import hermes_bootstrap; {NATIVE_ENTRY}"),
        ];
        let command = managed_argv(argv.clone(), Path::new("/private/host.py")).unwrap();
        assert!(command[3].starts_with("import runpy; import hermes_bootstrap; "));
        assert!(command[3].ends_with("runpy.run_path(sys.argv[1], run_name='__main__')"));
        assert_eq!(command[4], "/private/host.py");
        for index in 0..4 {
            let mut invalid = argv.clone();
            invalid[index] = "unexpected".into();
            assert!(managed_argv(invalid, Path::new("/private/host.py")).is_err());
        }
        let ready = json!({"revision":REVISION,"pid":123,"version":"0.22.4"});
        assert!(validate_ready(&ready, Some(123)).is_ok());
        assert!(validate_ready(&ready, Some(124)).is_err());
        assert!(validate_ready(&ready, None).is_err());
        assert!(!supported_version(Some("Hermes Agent v0.22.2")));
        for version in [
            "0.22.4",
            "Hermes Agent v0.22.5 (new source)",
            "0.23.0",
            "1.0.0",
        ] {
            assert!(supported_version(Some(version)), "{version}");
        }
        assert!(!supported_version(None));
    }

    // Actual native patch hunks are fragments, never proposed or full states.
    #[test]
    fn native_patch_requires_a_successful_corroborated_complete_hunk() {
        let update = json!({"status":"completed","rawInput":{"tool":"patch"},"rawOutput":{
            "success":true,"files_modified":["/project/a.txt"],"resolved_path":"/project/a.txt",
            "diff":"--- a//project/a.txt\n+++ b//project/a.txt\n@@ -1,3 +1,3 @@\n head\n-old\n+new\n tail\n"}});
        let result = reported_patch(&update).unwrap();
        assert_eq!(result[0]["semantics"], "reported_mutation");
        assert_eq!(
            result[0]["fragments"],
            json!([{"oldText":"old\n","newText":"new\n"}])
        );
        let mut no_newline = update.clone();
        no_newline["rawOutput"]["diff"] =
            json!("--- a//project/a.txt\n+++ b//project/a.txt\n@@ -1 +1 @@\n-old\r\n+new");
        assert_eq!(
            reported_patch(&no_newline).unwrap()[0]["fragments"],
            json!([{"oldText":"old\r\n","newText":"new"}])
        );
        for (pointer, value) in [
            ("/status", json!("failed")),
            ("/rawInput/tool", json!("write_file")),
            ("/rawOutput/success", json!(false)),
            ("/rawOutput/no_change", json!(true)),
            ("/rawOutput/files_modified", json!(["/project/other.txt"])),
            ("/rawOutput/files_created", json!(["/project/a.txt"])),
            (
                "/rawOutput/diff",
                json!("--- a//project/a.txt\n+++ b//project/a.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n"),
            ),
        ] {
            let mut invalid = update.clone();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            invalid.pointer_mut(parent).unwrap()[key] = value;
            assert!(reported_patch(&invalid).is_none(), "{pointer}");
        }
    }
}

/// Native patch results contain actual applied hunks. Keep them as reported
/// fragments, never complete file states or a proposal inferred from arguments.
pub fn reported_patch(update: &Value) -> Option<Value> {
    let output = &update["rawOutput"];
    if update["status"] == "completed"
        && output.get("error").is_none_or(Value::is_null)
        && output["no_change"] != true
        && ((update["rawInput"]["tool"] == "patch" && output["success"] == true)
            || (update["rawInput"]["tool"] == "write_file" && output["verified"] == true))
        && let Some(entries) = update
            .pointer("/_meta/rovaiHermesMutation")
            .and_then(Value::as_array)
    {
        let paths = output["files_modified"].as_array()?;
        if !entries.is_empty()
            && entries.len() <= 64
            && entries.iter().all(|entry| {
                entry["semantics"] == "reported_mutation" && paths.contains(&entry["path"])
            })
        {
            return Some(json!(entries));
        }
        return None;
    }
    if update["status"] != "completed"
        || update["rawInput"]["tool"] != "patch"
        || output["success"] != true
        || output["no_change"] == true
        || ["files_created", "files_deleted"]
            .iter()
            .any(|k| output[k].as_array().is_some_and(|v| !v.is_empty()))
    {
        return None;
    }
    let files = output["files_modified"].as_array()?;
    if files.len() != 1 {
        return None;
    }
    let path = files[0].as_str()?;
    if output["resolved_path"].as_str() != Some(path) {
        return None;
    }
    let patch = output["diff"].as_str()?;
    if patch.len() > 2 * 1024 * 1024 || patch.contains('\0') {
        return None;
    }
    let mut lines = patch.split_inclusive('\n');
    if lines.next()? != format!("--- a/{path}\n") || lines.next()? != format!("+++ b/{path}\n") {
        return None;
    }
    let mut fragments = Vec::new();
    let (mut old, mut new) = (String::new(), String::new());
    let (mut left_old, mut left_new) = (0usize, 0usize);
    let mut hunk = false;
    fn flush(fragments: &mut Vec<Value>, old: &mut String, new: &mut String) {
        if old != new {
            fragments.push(json!({"oldText":old, "newText":new}));
        }
        old.clear();
        new.clear();
    }
    fn count(range: &str, prefix: char) -> Option<usize> {
        let range = range.strip_prefix(prefix)?;
        let (start, count) = range.split_once(',').unwrap_or((range, "1"));
        start.parse::<usize>().ok()?;
        count.parse().ok()
    }
    for line in lines {
        if line.starts_with("@@ ") {
            if left_old != 0 || left_new != 0 {
                return None;
            }
            flush(&mut fragments, &mut old, &mut new);
            let header: Vec<_> = line.split_whitespace().collect();
            if header.len() < 4 || header[3] != "@@" {
                return None;
            }
            left_old = count(header[1], '-')?;
            left_new = count(header[2], '+')?;
            hunk = true;
        } else if !hunk {
            return None;
        } else if let Some(text) = line.strip_prefix('-') {
            left_old = left_old.checked_sub(1)?;
            old.push_str(text);
        } else if let Some(text) = line.strip_prefix('+') {
            left_new = left_new.checked_sub(1)?;
            new.push_str(text);
        } else if line.starts_with(' ') {
            left_old = left_old.checked_sub(1)?;
            left_new = left_new.checked_sub(1)?;
            flush(&mut fragments, &mut old, &mut new);
        } else {
            return None;
        }
        if fragments.len() > 1024 {
            return None;
        }
    }
    if !hunk || left_old != 0 || left_new != 0 {
        return None;
    }
    flush(&mut fragments, &mut old, &mut new);
    (!fragments.is_empty())
        .then(|| json!([{"semantics":"reported_mutation", "path":path, "fragments":fragments}]))
}
