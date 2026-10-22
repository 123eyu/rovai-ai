"""Rovai's process-owned entry into Hermes 0.22.4's native ACP implementation.

Loaded by Hermes's own isolated Python/bootstrap, never by a system Python or
PYTHONPATH. The adapter does not modify the installed package or provider config.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os

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
NATIVE_COMMIT = "4d04303818b61bf3aa09278af48356315515965b"
if version.derived_version != "0.22.4" or version.commit != NATIVE_COMMIT or version.dirty:
    raise RuntimeError("Rovai managed Hermes requires the verified, unmodified official 0.22.4 source")

REVISION = "rovai-hermes-host-v1"
MAX_BOOTSTRAP_BYTES = 128 * 1024


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
    return update


for module in (native_events, native_server):
    module.build_tool_start = tool_start
    module.build_tool_complete = tool_complete


class ManagedAIAgent(run_agent.AIAgent):
    def __init__(self, *args, **kwargs):
        kwargs.update(skip_memory=True, skip_background_review=True)
        super().__init__(*args, **kwargs)
        self.rovai_error = False

    def run_conversation(self, *args, **kwargs):
        self.rovai_error = False
        # Hermes result counters are session cumulative. ACP prompt results in
        # Rovai are turn deltas, including on a warm Host or after model rebuild.
        keys = ("prompt_tokens", "completion_tokens", "total_tokens", "cache_read_tokens", "reasoning_tokens")
        baseline = {key: getattr(self, "session_" + key, 0) for key in keys}
        try:
            result = super().run_conversation(*args, **kwargs)
            self.rovai_error = bool(result.get("failed") or result.get("error"))
            result = dict(result)
            for key in keys:
                if isinstance(result.get(key), int) and isinstance(baseline[key], int):
                    result[key] = max(0, result[key] - baseline[key])
            return result
        except Exception:
            self.rovai_error = True
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

    def _make_agent(self, **kwargs):
        agent = super()._make_agent(**kwargs)
        agent.rovai_native_overlay = agent.ephemeral_system_prompt or ""
        binding = self.bindings.get(kwargs["session_id"])
        if binding:
            self.apply_binding(agent, binding["bootstrap"])
        return agent

    @staticmethod
    def apply_binding(agent, bootstrap):
        base = agent.rovai_native_overlay
        agent.ephemeral_system_prompt = (base + "\n\n" if base else "") + bootstrap


class ManagedACP(HermesACPAgent):
    def __init__(self, session_manager):
        super().__init__(session_manager)
        self.rovai_active_prompts = set()

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

    async def set_config_option(self, config_id, session_id, value, **kwargs):
        # Upstream stores arbitrary options without applying them. Model changes
        # must use the native resolver, then acknowledge its actual selected ID.
        if config_id != "model":
            raise RequestError(-32602, "Unsupported Hermes configuration option")
        state = self.session_manager._sessions.get(session_id)
        if state is None:
            raise RequestError(-32602, "Unknown session")
        if session_id in self.rovai_active_prompts:
            raise RequestError(-32000, "Session is busy")
        await super().set_session_model(value, session_id)
        selected = self._build_model_state(state)
        return native_server.SetSessionConfigOptionResponse(config_options=[{
            "id": "model", "name": "Model", "type": "select", "category": "model",
            "currentValue": selected.current_model_id,
            "options": [{"value": item.model_id, "name": item.name} for item in selected.available_models],
        }])

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
            return {"revision": REVISION, "pid": os.getpid(), "commit": NATIVE_COMMIT}
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
        try:
            state.agent.rovai_error = True
            result = await super().prompt(prompt, session_id, **kwargs)
            if state.agent.rovai_error and result.stop_reason != "cancelled":
                raise RequestError(-32003, "Hermes turn failed; inspect native diagnostics")
            return result
        finally:
            self.rovai_active_prompts.discard(session_id)


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
