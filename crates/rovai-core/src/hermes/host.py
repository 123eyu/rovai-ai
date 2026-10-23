"""Owned transport for unmodified ``hermes acp`` and ``hermes gateway run``.

No native executor, session manager or tool is patched. Each controller owns one
private Gateway for one Run; its binding-scoped Home preserves native sessions.
"""
from __future__ import annotations

import asyncio
import contextlib
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import sys
import uuid

import hermes_yaml as yaml

REVISION = "rovai-hermes-host-v3"
MAX_BOOTSTRAP_BYTES = 128 * 1024


def native_file_fragments(name, result, inline, cwd):
    """Completed native snippets, never complete file states or disk snapshots.

    Raw patch hunks retain their bytes. Display-only write diffs lose newline
    provenance, so they remain reported fragments and cannot prove Add/Delete.
    Reject truncated displays, unknown paths and incomplete hunk counts.
    """
    if not isinstance(result, dict) or result.get("error") or result.get("no_change"):
        return None
    if not (name == "patch" and result.get("success") is True or
            name == "write_file" and result.get("verified") is True):
        return None
    paths = set(result.get("files_modified") or [])
    created, deleted = set(result.get("files_created") or []), set(result.get("files_deleted") or [])
    if not paths or len(paths) > 64 or not all(isinstance(p, str) and os.path.isabs(p) for p in paths):
        return None
    raw = result.get("diff") if name == "patch" else None
    if not isinstance(raw, str):
        if not isinstance(inline, str):
            return None
        lines = re.sub(r"\x1b\[[0-9;]*[mK]", "", inline).splitlines()
        headers = {}
        for path in paths:
            for label in (path, os.path.relpath(path, cwd)):
                headers[f"a/{label} → b/{label}"] = f"--- a/{path}\n+++ b/{path}\n"
        start = next((i for i, line in enumerate(lines) if line in headers), None)
        if start is None:
            return None
        raw = "".join(headers.get(line, line + "\n") for line in lines[start:])
    if len(raw.encode()) > 2 * 1024 * 1024 or "\0" in raw:
        return None
    lines = raw.splitlines(keepends=True)
    entries, i = [], 0
    while i < len(lines):
        if i + 1 >= len(lines) or not lines[i].startswith("--- ") or not lines[i + 1].startswith("+++ "):
            return None
        old_path, new_path = lines[i][4:].rstrip("\n"), lines[i+1][4:].rstrip("\n")
        path = new_path[2:] if new_path.startswith("b/") else old_path[2:] if old_path.startswith("a/") else None
        if path not in paths or (old_path != f"a/{path}" and not (old_path == "/dev/null" and path in created)) or (new_path != f"b/{path}" and not (new_path == "/dev/null" and path in deleted)):
            return None
        i += 2
        fragments, old, new, left_old, left_new, hunk = [], "", "", 0, 0, False
        while i < len(lines) and not lines[i].startswith("--- "):
            line = lines[i]
            header = re.fullmatch(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[^\n]*)\n?", line)
            if header:
                if left_old or left_new:
                    return None
                if old != new:
                    fragments.append({"oldText": old, "newText": new})
                old, new = "", ""
                left_old, left_new = int(header[2] or 1), int(header[4] or 1)
                hunk = True
            elif not hunk and old_path == "/dev/null" and line.startswith("+"):
                # Hermes Add File result emits the applied added lines without @@.
                new += line[1:]
            elif hunk and line.startswith("-") and left_old > 0:
                old += line[1:]
                left_old -= 1
            elif hunk and line.startswith("+") and left_new > 0:
                new += line[1:]
                left_new -= 1
            elif hunk and line.startswith(" ") and left_old > 0 and left_new > 0:
                left_old -= 1
                left_new -= 1
                if old != new:
                    fragments.append({"oldText": old, "newText": new})
                old, new = "", ""
            else:
                return None
            i += 1
        if left_old or left_new:
            return None
        if old != new:
            fragments.append({"oldText": old, "newText": new})
        if fragments:
            entries.append({"semantics": "reported_mutation", "path": path, "fragments": fragments})
    return entries or None


class Rejected(Exception):
    def __init__(self, message, code=-32003, data=None):
        super().__init__(message)
        self.error = {"code": code, "message": message}
        if data is not None:
            self.error["data"] = data


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
    lock = open(root / ".rovai-owner.lock", "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise Rejected("Hermes binding already has a live owner") from error
    home = root / "native-home"
    home.mkdir(mode=0o700, exist_ok=True)
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
    config.setdefault("gateway", {}).update(multiplex_profiles=False, auto_resume=False)
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
        target, original = home / name, source / name
        if target.is_symlink() and target.readlink() != original:
            target.unlink()
        if original.exists() and not target.exists() and not target.is_symlink():
            target.symlink_to(original, target_is_directory=original.is_dir())
    if (source / "auth.json").exists():
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
    private_write(home / "config.yaml", yaml.safe_dump(config, allow_unicode=True))
    os.environ["HERMES_HOME"] = str(home)
    # Reuse the selected installation's prepared dependency environment. Starting
    # a managed Run must never download/update dependencies in a private Home.
    os.environ["HERMES_DISABLE_LAZY_INSTALLS"] = "1"
    os.environ["GATEWAY_MULTIPLEX_PROFILES"] = "false"
    os.environ.pop("HERMES_PROFILE", None)
    return home, lock


class Controller:
    def __init__(self, home):
        self.home = home
        self.launcher = os.environ["ROVAI_HERMES_LAUNCHER"]
        self.gateway = self.acp = self.rpc = self.rpc_context = None
        self.tasks = set()
        self.pending = {}
        self.serial = 0
        self.session = self.attach = self.active = None
        self.bound = False
        self.initialization = None
        self.reasoning = "runtime_default"
        self.models = {}
        self.efforts = []
        self.watermark = None
        self.failure = None
        self.native_overlay = os.environ.get("HERMES_EPHEMERAL_SYSTEM_PROMPT", "")
        path = os.environ.get("ROVAI_HERMES_BOOTSTRAP_FILE")
        self.bootstrap = Path(path).read_text() if path else ""
        self.bootstrap_digest = hashlib.sha256(self.bootstrap.encode()).hexdigest()
        self.lifecycle = asyncio.Lock()
        self.stopping = False
        self.prompt_pending = False

    def task(self, awaitable):
        task = asyncio.create_task(awaitable)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    def emit(self, value):
        print(json.dumps({"jsonrpc": "2.0", **value}, ensure_ascii=False), flush=True)

    def update(self, value):
        self.emit({"method": "session/update", "params": {"sessionId": self.session, "update": value}})

    async def fail(self, message):
        self.failure = Rejected(message)
        for future in list(self.pending.values()):
            if not future.done():
                future.set_exception(self.failure)
        if self.active:
            self.active["started"].set()
            self.active["done"].set()

    async def native(self, method, params, timeout=60):
        if self.failure:
            raise self.failure
        self.serial += 1
        ident = self.serial
        future = asyncio.get_running_loop().create_future()
        self.pending[ident] = future
        try:
            self.acp.stdin.write((json.dumps({"jsonrpc": "2.0", "id": ident, "method": method, "params": params}) + "\n").encode())
            await self.acp.stdin.drain()
            return await asyncio.wait_for(future, timeout) if timeout else await future
        finally:
            self.pending.pop(ident, None)

    async def acp_events(self):
        try:
            while line := await self.acp.stdout.readline():
                message = json.loads(line)
                if "method" not in message:
                    future = self.pending.get(message.get("id"))
                    if future and not future.done():
                        if "error" in message:
                            error = message["error"]
                            future.set_exception(Rejected(error.get("message", "Hermes ACP failed"), error.get("code", -32603), error.get("data")))
                        else:
                            future.set_result(message.get("result", {}))
                elif "id" in message:
                    # Client requests (including native approvals) retain their
                    # native ID behind a namespace, separate from Core requests.
                    message["id"] = "hermes-client:" + json.dumps(message["id"])
                    self.emit(message)
                else:
                    update = message.get("params", {}).get("update", {})
                    kind = update.get("sessionUpdate")
                    # RPC carries successful result/args omitted by ACP's editor
                    # projection. Do not duplicate those bubbles or proposed diff.
                    if kind in ("tool_call", "tool_call_update"):
                        if str(update.get("toolCallId", "")).startswith("model-confirm-"):
                            self.emit(message)
                    else:
                        self.emit(message)
            if not self.stopping:
                await self.fail("Official Hermes ACP exited unexpectedly")
        except Exception:
            if not self.stopping:
                await self.fail("Official Hermes ACP transport failed")

    async def stderr(self, process):
        # stderr never becomes protocol output; native logging already redacts
        # provider errors. Preserve a bounded line, never credentials/config dumps.
        from agent.redact import redact_sensitive_text
        while line := await process.stderr.readline():
            sys.stderr.write(redact_sensitive_text(line.decode(errors="replace"), force=True)[:4000])
            sys.stderr.flush()

    async def start(self):
        from hermes_cli.gateway_runtime import attachable, discover_gateway_endpoint
        from hermes_cli.gateway_client import connect_gateway
        existing = await asyncio.to_thread(discover_gateway_endpoint, self.home)
        if attachable(existing):
            raise Rejected("Refusing to attach to an unowned Hermes Gateway")
        env = dict(os.environ)
        env["HERMES_EPHEMERAL_SYSTEM_PROMPT"] = "\n\n".join(p for p in (self.native_overlay, self.bootstrap) if p)
        self.gateway = await asyncio.create_subprocess_exec(self.launcher, "--profile", "default", "gateway", "run", "--force", "--no-supervise", "--external-supervisor", env=env, stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE, limit=4*1024*1024)
        self.task(self.stderr(self.gateway))
        deadline = asyncio.get_running_loop().time() + 55
        while asyncio.get_running_loop().time() < deadline:
            if self.gateway.returncode is not None:
                raise Rejected("Dedicated Hermes Gateway exited during startup")
            found = await asyncio.to_thread(discover_gateway_endpoint, self.home)
            if attachable(found):
                lock = json.loads((self.home / "gateway.lock").read_text())
                if lock.get("pid") != self.gateway.pid or Path(lock.get("hermes_home", "")).resolve() != self.home or found.endpoint.supervisor != "external":
                    raise Rejected("Dedicated Hermes Gateway ownership mismatch")
                self.rpc_context = connect_gateway(found.endpoint)
                self.rpc = await self.rpc_context.__aenter__()
                descriptor = await self.rpc.rpc("runtime.describe")
                required = {"durable-admission-v1", "event-replay-v1", "acp-editor-policy-v1", "acp-session-mcp-v1"}
                missing = required - set(descriptor.get("capabilities", []))
                if missing:
                    raise Rejected("Hermes Gateway is missing required capabilities: " + ", ".join(sorted(missing)))
                break
            await asyncio.sleep(.1)
        else:
            raise Rejected("Dedicated Hermes Gateway startup timed out")
        self.task(self.gateway_events())
        self.acp = await asyncio.create_subprocess_exec(self.launcher, "--profile", "default", "acp", env=env, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=4*1024*1024)
        self.task(self.stderr(self.acp))
        self.task(self.acp_events())
        if self.initialization is not None:
            await self.native("initialize", self.initialization)

    async def stop(self):
        self.stopping = True
        if self.acp and self.acp.returncode is None:
            self.acp.terminate()
        if self.rpc_context:
            with contextlib.suppress(Exception):
                await self.rpc_context.__aexit__(None, None, None)
        if self.gateway and self.gateway.returncode is None:
            self.gateway.terminate()
        for process in (self.acp, self.gateway):
            if process and process.returncode is None:
                try:
                    await asyncio.wait_for(process.wait(), 5)
                except asyncio.TimeoutError:
                    process.kill()
                    await process.wait()
        for task in list(self.tasks):
            if task is not asyncio.current_task():
                task.cancel()
        await asyncio.gather(*(t for t in self.tasks if t is not asyncio.current_task()), return_exceptions=True)
        self.acp = self.gateway = self.rpc = self.rpc_context = None
        self.stopping = False

    async def snapshot(self):
        snapshot = await self.rpc.rpc("session.resume", session_id=self.session)
        if snapshot.get("session_id") != self.session:
            raise Rejected("Native session identity mismatch")
        return snapshot

    async def idle_snapshot(self):
        snapshot = await self.snapshot()
        if snapshot.get("running") or snapshot.get("pending") or snapshot.get("prompts"):
            raise Rejected("Hermes session has unsettled execution; refusing a new turn")
        return snapshot

    async def gateway_events(self):
        try:
            while True:
                frame = await self.rpc.events.get()
                if isinstance(frame, Exception):
                    raise frame
                event = frame.get("params", {})
                if event.get("session_id") != self.session:
                    continue
                if event.get("type") == "session.replay_gap":
                    raise Rejected("Hermes event replay gap; execution evidence is incomplete")
                active = self.active
                if not active:
                    continue
                epoch, seq = event.get("replay_epoch"), event.get("seq", 0)
                if epoch != active["epoch"]:
                    raise Rejected("Hermes Gateway epoch changed during this Run")
                if seq <= active["seq"]:
                    continue
                active["seq"] = seq
                kind, aid = event.get("type"), event.get("admission_id")
                if kind == "message.start":
                    if active.get("admission") and active["admission"] != aid:
                        raise Rejected("Unexpected second Hermes admission")
                    if not aid or not isinstance(event.get("execution_generation"), int):
                        raise Rejected("Hermes admission is missing its execution identity")
                    active.update(admission=aid, generation=event["execution_generation"])
                    active["started"].set()
                if aid != active.get("admission") or not aid:
                    continue
                if event.get("execution_generation") != active.get("generation"):
                    raise Rejected("Hermes execution generation changed")
                if kind in ("tool.start", "tool.complete"):
                    self.tool_update(kind, event.get("payload", {}))
                elif kind == "message.complete":
                    for call_id in list(active["tools"]):
                        self.update({"sessionUpdate": "tool_call_update", "toolCallId": call_id, "status": "failed"})
                    active["tools"].clear()
                    active["done"].set()
        except asyncio.CancelledError:
            raise
        except Exception:
            if not self.stopping:
                await self.fail("Hermes Gateway event stream lost; refusing uncertain control")

    def tool_update(self, kind, payload):
        from acp_adapter.tools import build_tool_complete, build_tool_start
        call_id = payload.get("tool_call_id")
        name = payload.get("tool_name") or payload.get("name")
        args = payload.get("args") or {}
        if not call_id or not name or not isinstance(args, dict):
            raise Rejected("Invalid native tool event")
        if kind == "tool.start":
            update = build_tool_start(call_id, name, args)
            self.active["tools"][call_id] = (name, args)
        else:
            self.active["tools"].pop(call_id, None)
            result = payload.get("result")
            update = build_tool_complete(call_id, name, result if isinstance(result, str) else None, function_args=args, is_error=payload.get("is_error") is True)
        value = update.model_dump(by_alias=True, exclude_none=True)
        value["rawInput"] = dict(args, tool=name)
        value["content"] = [block for block in value.get("content", []) if block.get("type") != "diff"]
        if kind == "tool.complete":
            result = payload.get("result")
            if isinstance(result, str) and len(result.encode()) <= 2*1024*1024:
                try:
                    result = json.loads(result)
                except ValueError:
                    pass
                value["rawOutput"] = result
                if isinstance(result, dict) and result.get("resolved_path"):
                    value["locations"] = [{"path": result["resolved_path"]}]
            # Native display snippets are useful to inspect, but are NOT full
            # before/after evidence. Preserve them as text, never ACP diff blocks.
            inline = payload.get("inline_diff")
            fragments = native_file_fragments(name, result, inline, self.attach["cwd"])
            if fragments:
                value["_meta"] = {"rovaiHermesMutation": fragments}
            if isinstance(inline, str) and len(inline) <= 128*1024:
                inline = re.sub(r"\x1b\[[0-9;]*[mK]", "", inline)
                value.setdefault("content", []).append({"type": "content", "content": {"type": "text", "text": inline}})
        self.update(value)

    def config_options(self):
        models = self.models
        return [{"id": "model", "name": "Model", "type": "select", "category": "model", "currentValue": models.get("currentModelId", ""), "options": [{"value": item["modelId"], "name": item["name"]} for item in models.get("availableModels", [])]},
                {"id": "reasoning_effort", "name": "Reasoning effort", "type": "select", "category": "thought_level", "currentValue": self.reasoning, "options": [{"value": value, "name": value} for value in ["runtime_default", *self.efforts]]}]

    async def refresh_efforts(self):
        from agent.reasoning_effort import route_supported_efforts
        info = await self.rpc.rpc("session.info", session_id=self.session)
        self.efforts = list(route_supported_efforts(info.get("provider"), info.get("model"), info.get("api_mode")))

    async def mutate(self, operation, payload):
        snapshot = await self.idle_snapshot()
        return await self.rpc.rpc("session.mutate", session_id=self.session, operation=operation, payload=payload, expected_revision=snapshot["revision"], expected_generation=snapshot["execution_generation"], request_id=uuid.uuid4().hex)

    async def bind_mcp(self):
        servers = self.attach["mcpServers"]
        result = await self.mutate("editor_mcp", {"mcp_servers": servers})
        if sorted(result.get("mcp_servers", [])) != sorted(server["name"] for server in servers):
            raise Rejected("Hermes could not discover every assigned MCP server")

    async def prompt(self, params):
        if not self.bound:
            raise Rejected("Hermes Bootstrap is unbound", -32002)
        if self.active or self.prompt_pending:
            raise Rejected("Hermes Run is already active", -32000)
        prompt_id = params.get("_meta", {}).get("rovai", {}).get("promptId")
        if not prompt_id:
            raise Rejected("Hermes prompt requires a Core execution identity", -32602)
        # Exclusively owned Home + one session + no pending admission + subscribed
        # baseline + one outgoing prompt make message.start an exact admission
        # witness. We never select 'the latest' snapshot after transport loss.
        self.prompt_pending = True
        try:
            snapshot = await self.idle_snapshot()
            active = {"prompt": prompt_id, "epoch": snapshot["replay_epoch"], "seq": snapshot["last_sequence"], "started": asyncio.Event(), "done": asyncio.Event(), "tools": {}}
            self.active = active
            before = await self.rpc.rpc("session.stats", session_id=self.session)
            try:
                result = await self.native("session/prompt", params, timeout=None)
            except Rejected as error:
                result = None
                native_error = error
            else:
                native_error = None
            if active.get("admission"):
                await asyncio.wait_for(active["done"].wait(), 15)
                if self.failure:
                    raise self.failure
                receipt = await self.rpc.rpc("prompt.receipt", session_id=self.session, admission_id=active["admission"], include_result=True)
                native_result = receipt.get("result") or {}
                if native_error:
                    from agent.redact import redact_sensitive_text
                    detail = native_result.get("error") or native_result.get("final_response")
                    if detail:
                        raise Rejected("Hermes turn failed", data={"error": redact_sensitive_text(str(detail), force=True)[:4000]})
            if native_error:
                raise native_error
            # Native usage is cumulative in one executor and may reset on rebuild.
            # Each production controller executes only one Run; subtract only a
            # comparable baseline when tests exercise multiple turns explicitly.
            usage = result.get("usage")
            if isinstance(usage, dict):
                for key, native_key in (("inputTokens", "input_tokens"), ("outputTokens", "output_tokens"), ("totalTokens", "total_tokens"), ("cachedReadTokens", "cache_read_tokens"), ("thoughtTokens", "reasoning_tokens")):
                    if isinstance(usage.get(key), int):
                        baseline = before.get(native_key) or 0
                        usage[key] -= baseline if baseline <= usage[key] else 0
                # Hermes counts uncached input separately; Rovai's input total
                # includes cached reads, like the other adapters.
                if isinstance(usage.get("inputTokens"), int):
                    usage["inputTokens"] += usage.get("cachedReadTokens") or 0
            return result
        finally:
            self.active = None
            self.prompt_pending = False

    async def dispatch(self, method, params):
        if method == "_rovai/ready":
            from hermes_cli.version_info import get_version_info
            version = get_version_info().derived_version
            match = re.match(r"^(\d+)\.(\d+)\.(\d+)", version)
            if not match or tuple(map(int, match.groups())) < (0,22,4):
                raise Rejected("Rovai requires Hermes >= 0.22.4")
            return {"revision": REVISION, "pid": os.getpid(), "version": version}
        if method == "initialize":
            async with self.lifecycle:
                await self.start()
                result = await self.native(method, params)
                self.initialization = params
                return result
        if method in ("session/new", "session/load", "session/resume"):
            if self.session:
                raise Rejected("Hermes controller already owns a session")
            try:
                result = await self.native(method, params)
            except Rejected as error:
                if (error.error.get("data") or {}).get("details") == "not_found":
                    raise Rejected("Exact Hermes session is unavailable", -32001, {"code": "HERMES_SESSION_NOT_FOUND", "sessionId": params.get("sessionId")}) from error
                raise
            self.session = result.get("sessionId") or params.get("sessionId")
            self.attach = {"sessionId": self.session, "cwd": params["cwd"], "mcpServers": params.get("mcpServers", [])}
            self.models = result.get("models", {})
            await self.idle_snapshot()
            if method != "session/new" or self.attach["mcpServers"]:
                # ACP's empty list means "keep the other editor's servers".
                # This controller is the exclusive owner: an empty assignment
                # means revoke, through the public fenced mutation.
                # Nonempty assignments also verify native partial discovery;
                # silently dropping an assigned server is not a successful bind.
                await self.bind_mcp()
            await self.refresh_efforts()
            result["configOptions"] = self.config_options()
            return result
        if params.get("sessionId") != self.session or not self.session:
            raise Rejected("Unknown Hermes session", -32602)
        if method == "_rovai/bind":
            bootstrap = params.get("bootstrap")
            if not isinstance(bootstrap, str) or not bootstrap.strip() or len(bootstrap.encode()) > MAX_BOOTSTRAP_BYTES or hashlib.sha256(bootstrap.encode()).hexdigest() != params.get("sha256"):
                raise Rejected("Invalid Bootstrap size or digest", -32602)
            if self.active:
                raise Rejected("Cannot bind an active Hermes Run")
            if bootstrap != self.bootstrap:
                # Probe clients can bind after session/new. Production passes B
                # at spawn and only verifies this ACK; no double cold start.
                async with self.lifecycle:
                    await self.stop()
                    self.bootstrap = bootstrap
                    await self.start()
                    await self.native("session/load", self.attach)
                    await self.idle_snapshot()
                    if self.attach["mcpServers"]:
                        await self.bind_mcp()
            self.bound = True
            return {"revision": REVISION, "sessionId": self.session, "sha256": params["sha256"]}
        if method == "session/prompt":
            return await self.prompt(params)
        if method in ("session/cancel", "_rovai/steer"):
            active = self.active
            accepted = False
            if active and not self.failure and not active["done"].is_set():
                if method == "session/cancel" or active["prompt"] == params.get("expectedPromptId"):
                    await asyncio.wait_for(active["started"].wait(), 10)
                    if active.get("admission") and not self.failure and not active["done"].is_set():
                        try:
                            value = await self.rpc.rpc("session.interrupt" if method == "session/cancel" else "session.steer", session_id=self.session, execution_generation=active["generation"], **({"text": params["text"]} if method != "session/cancel" else {}))
                            if method == "_rovai/steer":
                                accepted = (value.get("status") == "queued" and
                                            value.get("execution_generation") == active["generation"])
                                if not accepted and not (value.get("status") == "rejected" and value.get("delivered") is False):
                                    raise Rejected("Hermes steering outcome is uncertain; input must not be resent")
                            else:
                                accepted = (value.get("session_id") == self.session and
                                            value.get("execution_generation") == active["generation"])
                        except Exception as error:
                            if str(error) not in ("stale_generation", "not_running"):
                                raise
            return {"accepted": bool(accepted), "inputId": params.get("inputId"), "promptId": params.get("expectedPromptId")}
        if method == "session/set_mode":
            await self.idle_snapshot()
            result = await self.native(method, params)
            info = await self.rpc.rpc("session.info", session_id=self.session)
            from acp_adapter.modes import MODE_TO_EDIT_APPROVAL_POLICY
            if info.get("edit_approval_policy") != MODE_TO_EDIT_APPROVAL_POLICY.get(params.get("modeId")):
                raise Rejected("Hermes did not apply edit approval policy")
            result["_meta"] = {"rovai": {"revision": REVISION, "sessionId": self.session, "modeId": params["modeId"]}}
            return result
        if method == "session/set_config_option":
            if self.active:
                raise Rejected("Hermes Run is active")
            value = params.get("value")
            if params.get("configId") == "model":
                await self.native("session/set_model", {"sessionId": self.session, "modelId": value})
                # Reload native fields to acknowledge the actual route, never a
                # generic config-option ACK (upstream ignores that option).
                loaded = await self.native("session/load", self.attach)
                self.models = loaded.get("models", {})
                if self.models.get("currentModelId") != value:
                    raise Rejected("Hermes model route did not match the requested selection")
                await self.refresh_efforts()
            elif params.get("configId") == "reasoning_effort":
                if value not in ["runtime_default", *self.efforts]:
                    raise Rejected("Unsupported native reasoning effort", -32602)
                result = await self.mutate("reasoning", {"effort": None if value == "runtime_default" else value})
                if result.get("effort") != (None if value == "runtime_default" else value):
                    raise Rejected("Hermes did not acknowledge reasoning effort")
                self.reasoning = value
            else:
                raise Rejected("Unsupported Hermes configuration option", -32602)
            return {"configOptions": self.config_options()}
        if method == "_rovai/session_info":
            stats = await self.rpc.rpc("session.stats", session_id=self.session)
            snapshot = await self.snapshot()
            return {"sessionId": self.session, "contextWindow": stats.get("context_length"), "compressionCount": stats.get("compression_count"), "historyMessages": snapshot.get("message_count")}
        if method == "_rovai/compact":
            raise Rejected("Rovai uses Hermes automatic threshold compaction only", -32601)
        return await self.native(method, params)

    async def handle(self, request):
        if "method" not in request:
            ident = request.get("id")
            if isinstance(ident, str) and ident.startswith("hermes-client:"):
                request["id"] = json.loads(ident[len("hermes-client:"):])
                self.acp.stdin.write((json.dumps(request) + "\n").encode())
                await self.acp.stdin.drain()
            return
        try:
            result = await self.dispatch(request["method"], request.get("params", {}))
            response = {"result": result}
        except Rejected as error:
            response = {"error": error.error}
        except Exception as error:
            from agent.redact import redact_sensitive_text
            response = {"error": {"code": -32603, "message": "Hermes transport request failed", "data": {"error": redact_sensitive_text(str(error), force=True)[:4000]}}}
        if "id" in request:
            self.emit({"id": request["id"], **response})


async def serve():
    home, lock = prepare_home()
    controller = Controller(home)
    reader = asyncio.StreamReader(limit=4*1024*1024)
    loop = asyncio.get_running_loop()
    transport, _ = await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    requests = set()
    stopped = asyncio.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopped.set)
    async def consume():
        while line := await reader.readline():
            task = asyncio.create_task(controller.handle(json.loads(line)))
            requests.add(task)
            task.add_done_callback(requests.discard)
        stopped.set()
    consumer = asyncio.create_task(consume())
    try:
        await stopped.wait()
    finally:
        transport.close()
        consumer.cancel()
        for task in requests:
            task.cancel()
        await asyncio.gather(*requests, return_exceptions=True)
        await controller.stop()
        lock.close()


if __name__ == "__main__":
    asyncio.run(serve())
