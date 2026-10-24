"""Launch the official ACP server with an owned, binding-scoped Gateway.

ACP stdin/stdout belong to Hermes itself: no forwarding, event reconstruction,
per-prompt receipts or supplementary observations participate in settlement.
The one-shot control entry only fills gaps in the official ACP surface.
"""
from __future__ import annotations

import asyncio
import copy
import json
import os
from pathlib import Path
import runpy
import signal
import subprocess
import sys
import time
import uuid

import hermes_yaml as yaml


class Rejected(Exception):
    pass


def session_state(snapshot):
    if snapshot.get("prompts"):
        return "approval"
    if snapshot.get("running"):
        return "running"
    pending = snapshot.get("pending") or []
    if any(row.get("status") != "unknown" for row in pending):
        return "queued"
    return "unknown" if pending else "idle"


def private_write(path, content):
    temp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(content)
    temp.replace(path)


def prepare_home():
    source = Path(os.environ.get("HERMES_HOME", Path.home() / ".hermes")).resolve()
    root = Path(os.environ["ROVAI_HERMES_STORAGE"]).resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if root == source or source in root.parents and root.name == "profiles":
        raise Rejected("Hermes managed storage must be independent of native Home")
    home = root / "native-home"
    home.mkdir(mode=0o700, exist_ok=True)
    # Installation/path/version changes update the executable, not the native
    # Home/profile to which this binding belongs. Adopt pre-v6 storage from its
    # existing native links, without moving or copying its session database.
    origin = root / "native-source.json"
    if origin.exists():
        source = Path(json.loads(origin.read_text())["home"])
    else:
        if (home / "state.db").exists():
            # If old storage has no source links, its saved configuration is
            # the remaining evidence. Keep it instead of adopting another Home.
            source = home
            for name in ("skills", "auth.json", "installs"):
                link = home / name
                if link.is_symlink():
                    original = link.readlink()
                    # Resolve the source directory, not another user symlink
                    # such as Home/installs pointing to a shared dependency cache.
                    source = (original if original.is_absolute() else link.parent / original).parent.resolve()
                    break
        private_write(origin, json.dumps({"home": str(source), "profile": "default"}))
    if not source.is_absolute():
        raise Rejected("Hermes native Home must be absolute")
    config_path = source / "config.yaml"
    config = yaml.safe_load(config_path.read_text()) if config_path.exists() else {}
    if not isinstance(config, dict):
        raise Rejected("Hermes native configuration must be a mapping")
    config = copy.deepcopy(config)
    assigned = json.loads(os.environ.get("ROVAI_HERMES_MCP_NAMES", "[]"))
    if not isinstance(assigned, list) or not all(isinstance(name, str) for name in assigned):
        raise Rejected("Invalid managed MCP assignment names")
    # Native editor servers have their own namespace. Remove same-named profile
    # entries before Gateway discovery so Rovai's assignment actually wins.
    for name in assigned:
        if isinstance(config.get("mcp_servers"), dict):
            config["mcp_servers"].pop(name, None)
    acp_toolsets = (config.get("platform_toolsets") or {}).get("acp")
    if isinstance(acp_toolsets, list):
        shadowed = set(assigned) | {"mcp-" + name for name in assigned}
        config["platform_toolsets"]["acp"] = [name for name in acp_toolsets if name not in shadowed]
    # Configuration, credentials and user skills remain native inputs; session
    # databases, control sockets, cron state and Gateway locks are never shared.
    from dotenv import dotenv_values
    for key, value in dotenv_values(source / ".env").items():
        if value is not None:
            os.environ.setdefault(key, value)
    # Explicit disables beat credential-driven platform auto-enable upstream.
    # No native platform plugin code is loaded by this discovery.
    package = Path(__import__("hermes_cli").__file__).parent.parent
    platform_names = {"telegram", "discord", "slack", "whatsapp", "signal", "api_server", "webhook", "msgraph_webhook", "relay"}
    platform_names.update((config.get("platforms") or {}).keys())
    bundled = package / "plugins" / "platforms"
    if bundled.is_dir():
        platform_names.update(path.name for path in bundled.iterdir() if path.is_dir())
    config["platforms"] = {name: {"enabled": False} for name in platform_names}
    # Native config accepts an empty YAML section (gateway: null).
    config["gateway"] = config.get("gateway") or {}
    config["gateway"].update(multiplex_profiles=False, auto_resume=False)
    config.setdefault("auxiliary", {}).setdefault("title_generation", {}).update(enabled=False, model_upgrade_enabled=False)
    config["auxiliary"].setdefault("background_review", {})["enabled"] = False
    config.setdefault("memory", {}).update(memory_enabled=False, user_profile_enabled=False)
    disabled = config.setdefault("agent", {}).setdefault("disabled_toolsets", [])
    for name in ("clarify", "cronjob"):
        if name not in disabled:
            disabled.append(name)
    terminal = config.setdefault("terminal", {})
    terminal["env_passthrough"] = sorted(set(terminal.get("env_passthrough") or []) | {k for k in os.environ if k.startswith("ROVAI_")})
    # A private Home must not seed a different user skill library. Native project
    # discovery and config.skills.external_dirs continue to resolve normally.
    for name in ("skills", "auth.json", "installs"):
        if source == home:
            break
        target, original = home / name, source / name
        if target.is_symlink() and target.readlink() != original:
            target.unlink()
        if original.exists() and not target.exists() and not target.is_symlink():
            target.symlink_to(original, target_is_directory=original.is_dir())
    if source != home and (source / "auth.json").exists():
        # Hermes atomic writes preserve the auth symlink. Share its native lock
        # too, so refresh transactions coordinate with the user's CLI.
        auth_lock = home / "auth.lock"
        if auth_lock.is_symlink() and auth_lock.readlink() != source / "auth.lock":
            auth_lock.unlink()
        if not auth_lock.exists() and not auth_lock.is_symlink():
            auth_lock.symlink_to(source / "auth.lock")
    skills = config.setdefault("skills", {})
    def skill_path(value):
        path = Path(os.path.expandvars(value)).expanduser()
        return str(path if path.is_absolute() else source / path)
    if isinstance(skills.get("external_dirs"), list):
        skills["external_dirs"] = [skill_path(p) for p in skills["external_dirs"]]
    if isinstance(skills.get("create_dir"), str) and skills["create_dir"].strip():
        skills["create_dir"] = skill_path(skills["create_dir"])
    hook_command = os.environ.get("ROVAI_HERMES_COMPACTION_HOOK")
    if hook_command:
        # Use the official configuration hook. Missing optional observations
        # must not add a second, internal-API startup eligibility gate.
        hooks = config.setdefault("hooks", {}).setdefault("post_compaction", [])
        if not any(hook.get("command") == hook_command for hook in hooks if isinstance(hook, dict)):
            hooks.append({"command": hook_command, "timeout": 5})
        # Consent only this owned observer, never blanket-approve user hooks.
        private_write(home / "shell-hooks-allowlist.json", json.dumps({"approvals": [
            {"event": "post_compaction", "command": hook_command}]}))
    private_write(home / "config.yaml", yaml.safe_dump(config, allow_unicode=True))
    os.environ["HERMES_HOME"] = str(home)
    # Reuse the selected installation's prepared dependency environment. Starting
    # a managed Run must never download/update dependencies in a private Home.
    os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
    os.environ["GATEWAY_MULTIPLEX_PROFILES"] = "false"
    os.environ.pop("HERMES_PROFILE", None)
    return home


class Control:
    def __init__(self, rpc):
        self.rpc = rpc

    async def read_snapshot(self, session):
        snapshot = await self.rpc.rpc("session.resume", session_id=session)
        if snapshot.get("session_id") != session:
            raise Rejected("Native session identity mismatch")
        return snapshot

    async def prepare_session(self, params):
        session = params["sessionId"]
        snapshot = await self.read_snapshot(session)
        state = session_state(snapshot)
        if state == "idle":
            # Official ACP interprets an empty list as 'keep existing servers'.
            # The binding owns the assignment, including explicit revocation.
            servers = params["mcpServers"]
            result = await self.rpc.rpc("session.mutate", session_id=session,
                operation="editor_mcp", payload={"mcp_servers": servers},
                expected_revision=snapshot["revision"],
                expected_generation=snapshot["execution_generation"], request_id=uuid.uuid4().hex)
            if sorted(result.get("mcp_servers", [])) != sorted(server["name"] for server in servers):
                raise Rejected("Hermes could not discover every assigned MCP server")
        return {"sessionId": session, "state": state}

    async def steer(self, params):
        session = params["sessionId"]
        snapshot = await self.read_snapshot(session)
        if not snapshot.get("running"):
            return {"accepted": False}
        result = await self.rpc.rpc("session.steer", session_id=session,
            execution_generation=snapshot["execution_generation"], text=params["text"])
        # Never retry a mutation whose response was lost.
        if result.get("status") == "rejected" and result.get("delivered") is False:
            return {"accepted": False}
        if result.get("status") != "queued" or result.get("execution_generation") != snapshot["execution_generation"]:
            raise Rejected("Hermes steering outcome is unknown")
        return {"accepted": True}

    async def recover_unknown(self, params):
        session = params.get("sessionId")
        if not isinstance(session, str) or not session:
            raise Rejected("Recovery requires an exact native session")
        snapshot = await self.read_snapshot(session)
        pending = snapshot.get("pending", [])

        def receipt_identity(receipt, admission, generation=None):
            if (receipt.get("ref", {}).get("session_id") != session or receipt.get("admission_id") != admission
                    or type(receipt.get("execution_generation")) is not int
                    or receipt["execution_generation"] <= 0
                    or (generation is not None and receipt["execution_generation"] != generation)):
                raise Rejected("Recovery receipt identity mismatch")
            return {"session_id": session, **{key: receipt.get(key) for key in
                    ("admission_id", "execution_generation", "status", "outcome")}}

        admission = params.get("admissionId")
        if admission is None:
            receipts = []
            for row in pending:
                receipt = await self.rpc.rpc("prompt.receipt", session_id=session, admission_id=row["admission_id"])
                receipts.append(receipt_identity(receipt, row["admission_id"], row["execution_generation"]))
            return {"sessionId": session, "receipts": receipts, "state": session_state(snapshot)}
        if snapshot.get("running") or snapshot.get("prompts") or any(row.get("status") != "unknown" for row in pending):
            # Resolving a blocker may drain queued work. Only inspection is
            # allowed while an execution/approval/queue still owns the Session.
            raise Rejected("Native session has active, approval or queued work; discard refused")
        generation = params.get("executionGeneration")
        if type(generation) is not int or generation <= 0 or params.get("acknowledgeEffects") is not True:
            raise Rejected("Explicit acknowledgement of possible external effects is required")
        receipt = receipt_identity(await self.rpc.rpc("prompt.receipt", session_id=session, admission_id=admission), admission, generation)
        if receipt["status"] == "terminal":
            if pending:
                raise Rejected("Another native admission is pending; inspect again")
            # Includes an uncertain response to a previous resolve. Query the
            # durable receipt; do not issue another mutation or replay input.
            return {"sessionId": session, "receipt": receipt, "resolved": False}
        if receipt["status"] != "unknown" or len(pending) != 1 or pending[0].get("admission_id") != admission:
            raise Rejected("Unknown execution changed; inspect the session again")
        resolved = await self.rpc.rpc("prompt.resolve_unknown", session_id=session,
                                      admission_id=admission, execution_generation=generation)
        receipt = receipt_identity(resolved, admission, generation)
        if receipt["status"] != "terminal":
            raise Rejected("Native recovery outcome is uncertain; inspect the exact receipt again")
        after = await self.read_snapshot(session)
        if after.get("session_id") != session or after.get("running") or after.get("pending") or after.get("prompts"):
            raise Rejected("Native session is still unsettled after acknowledgement")
        return {"sessionId": session, "receipt": receipt, "resolved": True}


async def control_request(request):
    home = Path(os.environ["ROVAI_HERMES_STORAGE"]).resolve() / "native-home"
    # The official client also reads its socket sidecar from native Home.
    os.environ["HERMES_HOME"] = str(home)
    os.environ.pop("HERMES_PROFILE", None)
    from hermes_cli.gateway_client import connect_gateway
    from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint
    found = await asyncio.to_thread(discover_gateway_endpoint, home)
    if not attachable(found):
        raise Rejected("Hermes Gateway is unavailable; the original Session is preserved")
    operations = {"prepare_session": Control.prepare_session,
                  "recover_unknown": Control.recover_unknown, "steer": Control.steer}
    operation = operations.get(request.get("operation"))
    if operation is None:
        raise Rejected("Unsupported Hermes control operation")
    async with connect_gateway(found.endpoint) as rpc:
        return await operation(Control(rpc), request["params"])


def serve():
    from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint
    home = prepare_home()
    if attachable(discover_gateway_endpoint(home)):
        raise Rejected("Hermes binding already has a live Gateway")
    env = dict(os.environ, HERMES_GATEWAY_MAX_STARTS="0")
    gateway = subprocess.Popen([os.environ["ROVAI_HERMES_LAUNCHER"], "--profile", "default",
        "gateway", "run", "--force", "--no-supervise", "--external-supervisor"],
        env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
    try:
        deadline = time.monotonic() + 55
        while time.monotonic() < deadline:
            if gateway.poll() is not None:
                raise Rejected("Dedicated Hermes Gateway exited during startup")
            found = discover_gateway_endpoint(home)
            if attachable(found):
                lock = json.loads((home / "gateway.lock").read_text())
                if (lock.get("pid") != gateway.pid
                        or Path(lock.get("hermes_home", "")).resolve() != home
                        or found.endpoint.supervisor != "external"):
                    raise Rejected("Dedicated Hermes Gateway ownership mismatch")
                break
            time.sleep(.1)
        else:
            raise Rejected("Dedicated Hermes Gateway startup timed out")
        # The installation's own ACP implementation reads/writes the inherited
        # protocol pipes directly. Do not intercept even one ordinary message.
        sys.argv = ["hermes", "--profile", "default", "acp"]
        runpy.run_module("hermes_cli.main", run_name="__main__", alter_sys=True)
    finally:
        if gateway.poll() is None:
            gateway.terminate()
            try:
                gateway.wait(timeout=5)
            except subprocess.TimeoutExpired:
                gateway.kill()
                gateway.wait()


if __name__ == "__main__":
    if os.environ.get("ROVAI_HERMES_CONTROL") == "1":
        try:
            result = asyncio.run(control_request(json.load(sys.stdin)))
            print(json.dumps({"result": result}), flush=True)
        except Exception as error:
            from agent.redact import redact_sensitive_text
            print(json.dumps({"error": redact_sensitive_text(str(error), force=True)[:4000]}), flush=True)
            sys.exit(1)
    else:
        def stop(_signum, _frame):
            raise SystemExit(0)
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        serve()
