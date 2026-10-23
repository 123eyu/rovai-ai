"""Rovai's process-owned entry into Hermes's native ACP implementation.

Loaded by Hermes's own isolated Python/bootstrap, never by a system Python or
PYTHONPATH. The adapter does not modify the installed package or provider config.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import contextvars
import functools
import threading

from acp_adapter.entry import _load_env, _setup_logging

_setup_logging()
_load_env()

from agent.ssl_verify import install_truststore

install_truststore()

import acp
from acp.exceptions import RequestError
from acp_adapter.server import HermesACPAgent
from acp_adapter.session import SessionManager
import run_agent

from hermes_cli.version_info import get_version_info

version = get_version_info()
native_version = re.match(r"^(\d+)\.(\d+)\.(\d+)", version.derived_version)
if not native_version or tuple(map(int, native_version.groups())) < (0, 22, 4):
    raise RuntimeError("Rovai requires Hermes >= 0.22.4")

REVISION = "rovai-hermes-host-v2"
MAX_BOOTSTRAP_BYTES = 128 * 1024

# Observe the actual native file executor, not editor proposals or a later Core
# filesystem/Git scan. Each tool gets its own collector, including parallel tools.
# Remote backends retain native patch fragments; local bounded UTF-8 writes carry
# complete states and the exact bytes accepted by the native atomic-write primitive.
from tools.file_operations import ShellFileOperations
from tools import file_operations_native as native_file_io
from tools.approval_context import _approval_tool_call_id
from agent import tool_executor

_file_changes = contextvars.ContextVar("rovai_hermes_file_changes", default=None)
_atomic_content = contextvars.ContextVar("rovai_hermes_atomic_content", default=None)
_completed_file_states = contextvars.ContextVar("rovai_hermes_completed_file_states", default=None)
_file_evidence = {}
_file_evidence_lock = threading.Lock()
_UNKNOWN = object()
MAX_FILE_BYTES = 1024 * 1024
MAX_TOOL_FILE_BYTES = 4 * 1024 * 1024


def local_file_state(ops, path):
    if not ops._native_read_enabled():
        return _UNKNOWN
    try:
        fd = native_file_io._open_regular(ops._native_path(ops._expand_path(path)))
        if fd is None:
            return None
        with open(fd, "rb") as file:
            content = file.read(MAX_FILE_BYTES + 1)
        if len(content) > MAX_FILE_BYTES or b"\x00" in content:
            return _UNKNOWN
        return content.decode("utf-8")
    except (OSError, UnicodeError):
        return _UNKNOWN


def record_file_state(ops, path, before, after):
    changes = _file_changes.get()
    if changes is None or before is _UNKNOWN or after is _UNKNOWN or before == after or len(changes) >= 64:
        return
    try:
        lengths = [len(text.encode("utf-8")) for text in (before, after) if text is not None]
        total = sum(len(text.encode("utf-8")) for entry in changes
                    for text in (entry["oldText"], entry["newText"]) if text is not None)
    except UnicodeError:
        return  # Evidence observation must never turn a successful native write into a failure.
    if (any(length > MAX_FILE_BYTES for length in lengths) or total + sum(lengths) > MAX_TOOL_FILE_BYTES
            or any(text is not None and "\x00" in text for text in (before, after))):
        return
    changes.append({"path": ops._native_path(ops._expand_path(path)),
                    "changeKind": "add" if before is None else "delete" if after is None else "update",
                    "oldText": before, "newText": after})


_native_atomic_write = ShellFileOperations._atomic_write


def observed_atomic_write(ops, path, content):
    result = _native_atomic_write(ops, path, content)
    slot = _atomic_content.get()
    if slot is not None and result.exit_code == 0:
        slot["content"] = content
    return result


ShellFileOperations._atomic_write = observed_atomic_write


def observe_file_operation(name, native):
    @functools.wraps(native)
    def observed(ops, *args, **kwargs):
        outer = _file_changes.get() is None
        token = _file_changes.set([]) if outer else None
        slot = {}
        atomic_token = _atomic_content.set(slot)
        try:
            path = args[0] if args else kwargs.get("path") or kwargs.get("src")
            before = local_file_state(ops, path) if name in ("write_file", "delete_file", "move_file") else _UNKNOWN
            destination = (args[1] if len(args) > 1 else kwargs.get("dst")) if name == "move_file" else None
            target = local_file_state(ops, destination) if destination else _UNKNOWN
            result = native(ops, *args, **kwargs)
            if not getattr(result, "error", None):
                if name == "write_file" and result.verified is True and "content" in slot:
                    after = slot["content"]
                    if hashlib.sha256(after.encode("utf-8", "surrogateescape")).hexdigest() == result._content_sha256:
                        record_file_state(ops, path, before, after)
                elif name == "delete_file":
                    record_file_state(ops, path, before, None)
                elif name == "move_file" and target is None:
                    record_file_state(ops, path, before, None)
                    record_file_state(ops, destination, None, before)
                if outer and getattr(result, "success", True) and (call_id := _approval_tool_call_id.get()):
                    with _file_evidence_lock:
                        if len(_file_evidence) >= 16:
                            _file_evidence.pop(next(iter(_file_evidence)))
                        _file_evidence[call_id] = _file_changes.get()
            return result
        finally:
            _atomic_content.reset(atomic_token)
            if token is not None:
                _file_changes.reset(token)
    return observed


for _name in ("write_file", "delete_file", "move_file", "patch_replace", "patch_v4a"):
    setattr(ShellFileOperations, _name, observe_file_operation(_name, getattr(ShellFileOperations, _name)))

_native_commit_tool_result = tool_executor._commit_tool_result


@functools.wraps(_native_commit_tool_result)
def commit_tool_result(agent, messages, ref, *args, **kwargs):
    with _file_evidence_lock:
        states = _file_evidence.pop(ref.call_id, None)
    token = _completed_file_states.set(states)
    try:
        return _native_commit_tool_result(agent, messages, ref, *args, **kwargs)
    finally:
        _completed_file_states.reset(token)


tool_executor._commit_tool_result = commit_tool_result


# Preserve the executor's structured input/result, which the default editor
# presentation intentionally omits. Proposed ACP diff blocks are never evidence
# of a completed mutation. Core receives only native terminal results here.
from acp_adapter import tools as tool_updates, events as native_events, server as native_server

_native_start = tool_updates.build_tool_start
_native_complete = tool_updates.build_tool_complete


def tool_start(call_id, name, arguments, **kwargs):
    update = _native_start(call_id, name, arguments, **kwargs)
    update.raw_input = dict(arguments, tool=name)
    if update.content:
        update.content = [block for block in update.content if block.type != "diff"]
    return update


def tool_complete(call_id, name, result=None, **kwargs):
    update = _native_complete(call_id, name, result, **kwargs)
    if isinstance(result, str) and len(result.encode("utf-8")) <= 2 * 1024 * 1024:
        try:
            update.raw_output = json.loads(result)
        except ValueError:
            update.raw_output = result
    if kwargs.get("function_args"):
        update.raw_input = dict(kwargs["function_args"], tool=name)
        update.locations = tool_updates.extract_locations(kwargs["function_args"])
    if update.content:
        update.content = [block for block in update.content if block.type != "diff"]
    states = _completed_file_states.get()
    if update.status == "completed" and name in ("write_file", "patch") and states:
        update.field_meta = {**(update.field_meta or {}), "rovaiHermesFileStates": states}
        if len(states) == 1:
            # Relative tool arguments and native resolved paths must describe the
            # same completed operation before Core chooses Add vs Write.
            update.locations = tool_updates.extract_locations({"path": states[0]["path"]})
    return update


for module in (native_events, native_server):
    module.build_tool_start = tool_start
    module.build_tool_complete = tool_complete


class ManagedAIAgent(run_agent.AIAgent):
    def __init__(self, *args, **kwargs):
        kwargs.update(skip_memory=True, skip_background_review=True)
        super().__init__(*args, **kwargs)
        self.rovai_error = False
        self.rovai_error_detail = None

    def run_conversation(self, *args, **kwargs):
        self.rovai_error = False
        self.rovai_error_detail = None
        # Hermes result counters are session cumulative. ACP prompt results in
        # Rovai are turn deltas, including on a warm Host or after model rebuild.
        keys = ("prompt_tokens", "completion_tokens", "total_tokens", "cache_read_tokens", "reasoning_tokens")
        baseline = {key: getattr(self, "session_" + key, 0) for key in keys}
        try:
            result = super().run_conversation(*args, **kwargs)
            self.rovai_error = bool(result.get("failed") or result.get("error"))
            if self.rovai_error:
                from agent.redact import redact_sensitive_text
                detail = result.get("error") or result.get("final_response") or "Hermes turn failed"
                self.rovai_error_detail = redact_sensitive_text(str(detail), force=True)[:4000]
            result = dict(result)
            for key in keys:
                if isinstance(result.get(key), int) and isinstance(baseline[key], int):
                    result[key] = max(0, result[key] - baseline[key])
            return result
        except Exception as error:
            from agent.redact import redact_sensitive_text
            self.rovai_error = True
            self.rovai_error_detail = redact_sensitive_text(str(error), force=True)[:4000]
            raise


# SessionManager imports the real class at construction time. Only this child
# process gets the managed policy; the user's CLI/Gateway remains untouched.
run_agent.AIAgent = ManagedAIAgent

# Rovai owns Thread titles. Native ACP otherwise starts a separate model call
# after the prompt, outside the Run's usage and terminal boundary.
from agent import title_generator

title_generator._auto_title_enabled = lambda: False

# Install before any Session/AIAgent construction: native background discovery
# otherwise connects a same-name native server first and explicit ACP registration
# silently reuses it. Preserve native configuration, overlay this Host's immutable
# assignment in memory, including reconnects and late discovery.
from tools import mcp_tool_config

_native_mcp_config = mcp_tool_config._load_mcp_config
_managed_mcp = {}


def managed_mcp_config():
    return {**_native_mcp_config(), **_managed_mcp}


mcp_tool_config._load_mcp_config = managed_mcp_config


class ManagedSessions(SessionManager):
    def __init__(self):
        super().__init__()
        self.bindings = {}
        self.reasoning = {}

    def _make_agent(self, **kwargs):
        agent = super()._make_agent(**kwargs)
        agent.rovai_native_overlay = agent.ephemeral_system_prompt or ""
        # AIAgent canonicalizes named custom providers to "custom". Retain the
        # native resolver's constructor route so its own catalog can round-trip
        # the selected endpoint instead of returning an ambiguous model ID.
        agent.rovai_requested_provider = kwargs.get("requested_provider")
        binding = self.bindings.get(kwargs["session_id"])
        if binding:
            self.apply_binding(agent, binding["bootstrap"])
        if kwargs["session_id"] in self.reasoning:
            from hermes_constants import parse_reasoning_effort
            agent.reasoning_config = parse_reasoning_effort(self.reasoning[kwargs["session_id"]])
        return agent

    @staticmethod
    def apply_binding(agent, bootstrap):
        base = agent.rovai_native_overlay
        agent.ephemeral_system_prompt = (base + "\n\n" if base else "") + bootstrap


class ManagedACP(HermesACPAgent):
    def __init__(self, session_manager):
        super().__init__(session_manager)
        self.rovai_active_prompts = set()
        self.rovai_prompt_ids = {}

    def prepare_mcp(self, mcp_servers):
        configs = {s.name: native_server._mcp_server_config(s) for s in mcp_servers or []}
        signature = json.dumps(configs, sort_keys=True)
        if hasattr(self, "rovai_mcp_signature") and self.rovai_mcp_signature != signature:
            raise RequestError(-32004, "Changed MCP assignment requires a new managed Host")
        self.rovai_mcp_signature = signature
        _managed_mcp.update(configs)
        return configs

    async def new_session(self, cwd, mcp_servers=None, **kwargs):
        self.prepare_mcp(mcp_servers)
        return await super().new_session(cwd, mcp_servers, **kwargs)

    def _build_model_state(self, state):
        provider = getattr(state.agent, "rovai_requested_provider", None)
        if provider:
            selected = native_server.build_model_state(state.model, provider, state.agent.base_url or "")
            if selected is not None:
                return selected
        return super()._build_model_state(state)

    def managed_config_options(self, state):
        from agent.reasoning_effort import route_supported_efforts
        selected = self._build_model_state(state)
        agent = state.agent
        levels = route_supported_efforts(agent.provider, agent.model, getattr(agent, "api_mode", None))
        return [{
            "id": "model", "name": "Model", "type": "select", "category": "model",
            "currentValue": selected.current_model_id,
            "options": [{"value": item.model_id, "name": item.name} for item in selected.available_models],
        }, {
            "id": "reasoning_effort", "name": "Reasoning effort", "type": "select", "category": "thought_level",
            "currentValue": self.session_manager.reasoning.get(state.session_id, "runtime_default"),
            "options": [{"value": "runtime_default", "name": "Runtime default"}]
                + [{"value": level, "name": level} for level in levels],
        }]

    async def _session_response_fields(self, state, replay_verb=None):
        result = await super()._session_response_fields(state, replay_verb)
        result["config_options"] = self.managed_config_options(state)
        return result

    async def set_config_option(self, config_id, session_id, value, **kwargs):
        # Upstream stores arbitrary options without applying them. Model changes
        # must use the native resolver, then acknowledge its actual selected ID.
        if config_id not in ("model", "reasoning_effort"):
            raise RequestError(-32602, "Unsupported Hermes configuration option")
        state = self.session_manager._sessions.get(session_id)
        if state is None:
            raise RequestError(-32602, "Unknown session")
        if session_id in self.rovai_active_prompts:
            raise RequestError(-32000, "Session is busy")
        if config_id == "model":
            try:
                await super().set_session_model(value, session_id)
            except (native_server.ModelRejected, RequestError) as error:
                from agent.redact import redact_sensitive_text
                details = getattr(error, "data", None)
                details = details.get("details") or details.get("error") if isinstance(details, dict) else details
                raise RequestError(-32602, "Hermes rejected the model", {
                    "error": redact_sensitive_text(str(details or error), force=True)[:4000],
                }) from error
        else:
            from hermes_cli.config import load_config
            from hermes_constants import parse_reasoning_effort, resolve_reasoning_config
            options = self.managed_config_options(state)[1]["options"]
            if value not in {option["value"] for option in options}:
                raise RequestError(-32602, "Unsupported Hermes reasoning effort")
            if value != "runtime_default":
                self.session_manager.reasoning[session_id] = value
                state.agent.reasoning_config = parse_reasoning_effort(value)
            else:
                self.session_manager.reasoning.pop(session_id, None)
                state.agent.reasoning_config = resolve_reasoning_config(load_config(), state.model)
        return native_server.SetSessionConfigOptionResponse(config_options=self.managed_config_options(state))

    async def set_session_mode(self, mode_id, session_id, **kwargs):
        state = self.session_manager._sessions.get(session_id)
        if state is None or mode_id not in self._MODES:
            raise RequestError(-32602, "Unknown session or edit approval mode")
        with state.runtime_lock:
            if state.is_running or state.command_op or session_id in self.rovai_active_prompts:
                raise RequestError(-32000, "Session is busy")
            state.mode = mode_id
            self.session_manager.save_session(session_id)
        return native_server.SetSessionModeResponse(field_meta={"rovai": {
            "revision": REVISION, "sessionId": session_id, "modeId": state.mode,
        }})

    async def _register_session_mcp_servers(self, state, mcp_servers):
        from tools.mcp_tool_discovery import get_mcp_status
        configs = self.prepare_mcp(mcp_servers)
        await super()._register_session_mcp_servers(state, mcp_servers)
        statuses = get_mcp_status(configs)
        if len(statuses) != len(configs) or any(s["status"] not in ("connected", "lazy") for s in statuses):
            raise RequestError(-32004, "Hermes did not register the assigned MCP servers")

    async def ext_method(self, method, params):
        if method == "rovai/ready":
            return {"revision": REVISION, "pid": os.getpid(), "version": version.derived_version}
        if method == "rovai/session_info":
            state = self.session_manager._sessions.get(params.get("sessionId"))
            if state is None:
                raise RequestError(-32602, "Unknown session")
            compressor = state.agent.context_compressor
            return {"sessionId": state.session_id, "contextWindow": compressor.context_length,
                    "compressionThreshold": compressor.threshold_tokens,
                    "compressionCount": compressor.compression_count,
                    "historyMessages": len(state.history)}
        if method == "rovai/steer":
            session_id = params.get("sessionId")
            state = self.session_manager._sessions.get(session_id)
            text = params.get("text")
            input_id = params.get("inputId")
            if not state or not isinstance(text, str) or not text.strip() or not input_id:
                raise RequestError(-32602, "Invalid steering input")
            with state.runtime_lock:
                if (not state.is_running or state.command_op or state.cancel_event.is_set()
                        or not params.get("expectedPromptId")
                        or self.rovai_prompt_ids.get(session_id) != params["expectedPromptId"]):
                    return {"accepted": False, "inputId": input_id}
                # Native redirect interrupts only an in-flight model request; tools
                # keep running and receive the correction after their result. Never
                # use concurrent prompt(), whose idle fallback queues a new turn.
                accepted = bool(state.agent.redirect(text))
            return {"accepted": accepted, "inputId": input_id,
                    "promptId": params["expectedPromptId"]}
        if method == "rovai/compact":
            return await self.compact(params.get("sessionId"))
        if method != "rovai/bind":
            raise RequestError(-32601, "Unknown managed method")
        session_id = params.get("sessionId")
        state = await asyncio.to_thread(self.session_manager.get_session, session_id)
        bootstrap = params.get("bootstrap")
        if state is None or not isinstance(bootstrap, str) or not bootstrap.strip():
            raise RequestError(-32602, "A live session and nonempty Bootstrap are required")
        encoded = bootstrap.encode("utf-8")
        digest = hashlib.sha256(encoded).hexdigest()
        if len(encoded) > MAX_BOOTSTRAP_BYTES or digest != params.get("sha256"):
            raise RequestError(-32602, "Invalid Bootstrap size or digest")
        with state.runtime_lock:
            if state.is_running or state.command_op or session_id in self.rovai_active_prompts:
                raise RequestError(-32000, "Cannot bind an active session")
            self.session_manager.apply_binding(state.agent, bootstrap)
            self.session_manager.bindings[session_id] = {"bootstrap": bootstrap, "sha256": digest}
        return {"revision": REVISION, "sessionId": session_id, "sha256": digest}

    async def compact(self, session_id):
        state = self.session_manager._sessions.get(session_id)
        if state is None or session_id not in self.session_manager.bindings:
            raise RequestError(-32002, "Managed Bootstrap has not been bound")
        with state.runtime_lock:
            if state.is_running or state.command_op or session_id in self.rovai_active_prompts:
                raise RequestError(-32000, "Session is busy")
            state.command_op = "rovai/compact"
            state.cancel_event.clear()
        try:
            return await asyncio.to_thread(self._compact, state)
        finally:
            with state.runtime_lock:
                state.command_op = None

    def _compact(self, state):
        from agent.conversation_compression import finalize_context_engine_compression_notification
        from agent.conversation_compression_manual import compress_now, parse_compress_args

        agent = state.agent
        database = agent._session_db
        try:
            agent._session_db = None  # same stable ACP identity rule as native /compress
            result = compress_now(agent, state.history, parse_compress_args(""),
                                  system_message=agent._cached_system_prompt or "", task_id=state.session_id)
        finally:
            agent._session_db = database
        if state.cancel_event.is_set():
            finalize_context_engine_compression_notification(agent, committed=False)
            raise RequestError(-32005, "Compaction cancelled; discard this Host")
        if result.status == "compressed":
            state.history = result.after_messages
            self.session_manager.save_session(state.session_id)
            finalize_context_engine_compression_notification(agent, committed=True)
        return {"status": result.status, "sessionId": state.session_id,
                "beforeTokens": result.before_tokens, "afterTokens": result.after_tokens}

    async def resume_session(self, cwd, session_id, mcp_servers=None, **kwargs):
        self.prepare_mcp(mcp_servers)
        state = await asyncio.to_thread(self.session_manager.get_session, session_id)
        if state is None:
            raise RequestError(-32001, "Exact Hermes session is unavailable", {
                "code": "HERMES_SESSION_NOT_FOUND", "sessionId": session_id})
        return await super().resume_session(cwd, session_id, mcp_servers, **kwargs)

    async def load_session(self, cwd, session_id, mcp_servers=None, **kwargs):
        self.prepare_mcp(mcp_servers)
        state = await asyncio.to_thread(self.session_manager.get_session, session_id)
        if state is None:
            raise RequestError(-32001, "Exact Hermes session is unavailable", {
                "code": "HERMES_SESSION_NOT_FOUND", "sessionId": session_id})
        return await super().load_session(cwd, session_id, mcp_servers, **kwargs)

    async def prompt(self, prompt, session_id, **kwargs):
        state = self.session_manager._sessions.get(session_id)
        if state is None or session_id not in self.session_manager.bindings:
            raise RequestError(-32002, "Managed Bootstrap has not been bound")
        with state.runtime_lock:
            if state.is_running or state.command_op or session_id in self.rovai_active_prompts:
                raise RequestError(-32000, "Session is busy; queue belongs to Rovai")
        # Conservative sentinel also catches errors swallowed by ACP before the
        # real executor starts. Only a completed native conversation clears it.
        self.rovai_active_prompts.add(session_id)
        meta = kwargs.get("field_meta") or kwargs.get("_meta") or kwargs
        self.rovai_prompt_ids[session_id] = meta.get("rovai", {}).get("promptId")
        try:
            state.agent.rovai_error = True
            state.agent.rovai_error_detail = None
            result = await super().prompt(prompt, session_id, **kwargs)
            if state.agent.rovai_error and result.stop_reason != "cancelled":
                raise RequestError(-32003, "Hermes turn failed", {
                    "error": state.agent.rovai_error_detail or "Native execution did not complete",
                })
            return result
        finally:
            self.rovai_active_prompts.discard(session_id)
            self.rovai_prompt_ids.pop(session_id, None)


async def serve():
    agent = ManagedACP(ManagedSessions())
    try:
        await acp.run_agent(agent, use_unstable_protocol=True)
    finally:
        # Core also owns the process group. EOF must not leave a background owner.
        from tools.mcp_tool_lifecycle import shutdown_mcp_servers
        await asyncio.to_thread(shutdown_mcp_servers)


if __name__ == "__main__":
    asyncio.run(serve())
