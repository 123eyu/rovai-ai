"""Deterministic controller ordering/parser regressions; no Runtime or credentials."""
import asyncio
import difflib
import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

HOST = Path(__file__).resolve().parents[1] / "crates/rovai-core/src/hermes/host.py"
spec = importlib.util.spec_from_file_location("hermes_controller", HOST)
host = importlib.util.module_from_spec(spec)
# Home preparation is outside these owners; loading the controller needs no
# installed Hermes. Native prompt precedence is covered by the wire smoke.
with patch.dict(sys.modules, {"hermes_yaml": types.ModuleType("hermes_yaml")}):
    spec.loader.exec_module(host)


class NativeFragments(unittest.TestCase):
    def test_native_multifile_updates_preserve_hunk_boundaries(self):
        for old_a in ("old\n", "-- heading\nold\n"):
            with self.subTest(old_a=old_a):
                diffs = ["".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True),
                            fromfile="a/" + path, tofile="b/" + path))
                         for path, old, new in (("/p/a.sql", old_a, "new\n"), ("/p/b.txt", "before\n", "after\n"))]
                native = {"success": True, "files_modified": ["/p/a.sql", "/p/b.txt"], "diff": "\n".join(diffs)}
                result = host.native_file_fragments("patch", native, None, "/p")
                self.assertEqual(result, [
                    {"semantics": "reported_mutation", "path": "/p/a.sql", "fragments": [{"oldText": old_a, "newText": "new\n"}]},
                    {"semantics": "reported_mutation", "path": "/p/b.txt", "fragments": [{"oldText": "before\n", "newText": "after\n"}]}])
                for diff in (native["diff"].replace("+after\n", ""), native["diff"].replace("+new\n", "\n+new\n"),
                             native["diff"].replace("b//p/b.txt", "b//p/other"), native["diff"] + "\0"):
                    self.assertIsNone(host.native_file_fragments("patch", dict(native, diff=diff), None, "/p"))


class PromptSettlement(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        # Redaction itself is native; deterministic fixture messages contain no
        # secrets. Real provider details are exercised by the wire/Core smokes.
        redact = types.ModuleType("agent.redact")
        redact.redact_sensitive_text = lambda text, **kwargs: text
        self.modules = patch.dict(sys.modules, {"agent.redact": redact})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def setup_controller(self, *, admitted=True, stop="end_turn", error=None):
        c = host.Controller.__new__(host.Controller)
        c.active, c.prompt_pending, c.failure, c.session = None, False, None, "session"
        c.update = Mock()
        c.tool_update = Mock()
        snapshot = {"replay_epoch": "epoch", "last_sequence": 0, "execution_generation": 1}
        c.idle_snapshot = AsyncMock(return_value=snapshot)
        self.events = [{"session_id": "session", "replay_epoch": "epoch", "seq": i + 1,
                        "admission_id": "admission", "execution_generation": 2, "type": kind, "payload": payload}
                       for i, (kind, payload) in enumerate([
                           ("message.start", {}), ("tool.complete", {"proof": "file evidence"}),
                           ("session.usage", {"input_tokens": 60, "output_tokens": 10, "cache_read_tokens": 40}),
                           ("message.complete", {})])] if admitted else []
        self.receipt = {"admission_id": "admission", "ref": {"session_id": "session"},
                        "execution_generation": 2, "status": "terminal", "outcome": "completed"}
        self.replay_override = {}

        async def rpc(method, **params):
            if method == "session.stats":
                return {}
            if method == "session.events.since":
                return {"replay_epoch": "epoch", "last_sequence": len(self.events),
                        "events": self.events, **self.replay_override}
            self.assertEqual(method, "prompt.receipt")
            self.assertEqual(params["admission_id"], "admission")
            self.assertTrue(c.active["done"].is_set())
            c.tool_update.assert_called_once_with("tool.complete", {"proof": "file evidence"})
            return self.receipt

        c.rpc = types.SimpleNamespace(rpc=AsyncMock(side_effect=rpc))

        async def native(*args, **kwargs):
            # ACP returns while the entire Gateway queue is still unconsumed.
            self.assertNotIn("admission", c.active)
            if error:
                raise error
            return {"stopReason": stop}

        c.native = native
        self.params = {"sessionId": "session", "prompt": [{"type": "text", "text": "ordinary"}],
                       "_meta": {"rovai": {"promptId": "prompt"}}}
        return c

    async def test_acp_terminal_drains_delayed_admission_and_evidence_once(self):
        c = self.setup_controller()
        result = await c.prompt(self.params)
        self.assertEqual(result["usage"], {"inputTokens": 100, "outputTokens": 10, "cachedReadTokens": 40})
        self.assertIsNone(c.active)
        for event in self.events:
            c.consume_event(event)  # late live copies must not duplicate evidence
        c.tool_update.assert_called_once()

    async def test_missing_or_mismatched_execution_never_succeeds(self):
        for defect in ("no-admission", "replay-gap", "epoch", "generation", "sequence"):
            with self.subTest(defect=defect):
                c = self.setup_controller(admitted=defect != "no-admission")
                if defect == "replay-gap": self.replay_override["truncated"] = True
                if defect == "epoch": self.replay_override["replay_epoch"] = "other"
                if defect == "generation": self.receipt["execution_generation"] = 3
                if defect == "sequence": self.events[1]["seq"] = 5
                with self.assertRaises(host.Rejected) as caught:
                    await c.prompt(self.params)
                self.assertEqual(caught.exception.error["data"]["code"], "HERMES_EXECUTION_UNCERTAIN")
                self.assertIsNone(c.active)

    async def test_native_unsubmitted_rejection_and_cancel_do_not_wait_for_admission(self):
        c = self.setup_controller(admitted=False, stop="cancelled")
        self.assertEqual(await c.prompt(self.params), {"stopReason": "cancelled"})
        rejected = host.Rejected("Invalid input", -32602)
        c = self.setup_controller(admitted=False, error=rejected)
        with self.assertRaises(host.Rejected) as caught:
            await c.prompt(self.params)
        self.assertIs(caught.exception, rejected)
        self.assertFalse(any(call.args[0] == "prompt.receipt" for call in c.rpc.rpc.call_args_list))

    async def test_unknown_recovery_is_exact_explicit_control_without_prompt(self):
        for case in ("inspect", "resolve", "terminal", "no_ack", "wrong_generation", "wrong_session",
                     "queued", "running", "approval", "multiple", "wrong_after"):
            with self.subTest(case=case):
                c = host.Controller.__new__(host.Controller)
                c.session, c.active, c.prompt_pending = None, None, False
                c.native = AsyncMock()
                receipt = {"ref": {"session_id": "session"}, "admission_id": "admission",
                           "execution_generation": 2, "status": "unknown", "outcome": None}
                snapshot = {"session_id": "session", "pending": [receipt]}
                params = {"sessionId": "session", "admissionId": "admission",
                          "executionGeneration": 2, "acknowledgeEffects": True}
                if case == "inspect": params = {"sessionId": "session"}
                if case == "no_ack": params["acknowledgeEffects"] = False
                if case == "wrong_generation": params["executionGeneration"] = 3
                if case == "wrong_session": receipt["ref"]["session_id"] = "another"
                if case == "queued": receipt["status"] = "queued"
                if case == "running": snapshot["running"] = True
                if case == "approval": snapshot["prompts"] = [{"id": "permission"}]
                if case == "multiple": snapshot["pending"] = [receipt, dict(receipt, admission_id="other")]
                if case == "terminal":
                    receipt.update(status="terminal", outcome="completed")
                    snapshot["pending"] = []
                async def rpc(method, **args):
                    self.assertEqual(args["session_id"], "session")
                    if method == "session.resume": return snapshot
                    if method == "prompt.receipt" and args["admission_id"] == "other": return dict(receipt, admission_id="other")
                    self.assertEqual(args["admission_id"], "admission")
                    if method == "prompt.receipt": return receipt
                    self.assertEqual(method, "prompt.resolve_unknown")
                    self.assertEqual(args["execution_generation"], 2)
                    receipt.update(status="terminal", outcome="interrupted")
                    snapshot["pending"] = []
                    if case == "wrong_after": snapshot["session_id"] = "another"
                    return receipt
                c.rpc = types.SimpleNamespace(rpc=AsyncMock(side_effect=rpc))
                async def read_snapshot(session): return await rpc("session.resume", session_id=session)
                c.read_snapshot = AsyncMock(side_effect=read_snapshot)
                if case in ("inspect", "resolve", "terminal"):
                    result = await c.recover_unknown(params)
                    self.assertEqual(result["sessionId"], "session")
                    if case == "inspect": self.assertEqual(result["receipts"][0]["status"], "unknown")
                    else: self.assertEqual(result["receipt"]["status"], "terminal")
                else:
                    with self.assertRaises(host.Rejected): await c.recover_unknown(params)
                calls = [call.args[0] for call in c.rpc.rpc.call_args_list]
                self.assertEqual(calls.count("prompt.resolve_unknown"), int(case in ("resolve", "wrong_after")))
                c.native.assert_not_called()

                if case in ("queued", "running", "approval", "multiple"):
                    inspected = await c.recover_unknown({"sessionId": "session"})
                    self.assertEqual(inspected["state"], "unknown" if case == "multiple" else case)
                    self.assertTrue(inspected["receipts"])
                    c.native.assert_not_called()

    async def test_restore_history_before_gating_new_input(self):
        for state, extra in (("idle", {}), ("running", {"running": True}),
                             ("approval", {"prompts": [{"id": "approval"}]}),
                             ("unknown", {"pending": [{"status": "unknown"}]}),
                             ("queued", {"pending": [{"status": "queued"}]})):
            with self.subTest(state=state):
                c = host.Controller.__new__(host.Controller)
                c.session, c.active, c.prompt_pending = None, None, False
                c.native = AsyncMock(return_value={"sessionId": "original", "models": {}})
                c.read_snapshot = AsyncMock(return_value={"session_id": "original", **extra})
                c.refresh_efforts, c.bind_mcp = AsyncMock(), AsyncMock()
                c.config_options = Mock(return_value=[])
                result = await c.dispatch("session/load", {"sessionId": "original", "cwd": "/p", "mcpServers": [{"name": "changed"}]})
                self.assertEqual(result["sessionId"], "original")
                self.assertEqual(result["_meta"]["rovaiHermesState"]["state"], state)
                self.assertEqual(c.native.call_args.args[1]["mcpServers"], [])
                self.assertEqual(c.bind_mcp.await_count, int(state == "idle"))
                if state != "idle":
                    with self.assertRaises(host.Rejected) as error:
                        await c.idle_snapshot()
                    self.assertEqual(error.exception.error["data"]["code"], "HERMES_SESSION_BLOCKED")
                    self.assertEqual(error.exception.error["data"]["state"], state)
                self.assertEqual([call.args[0] for call in c.native.call_args_list], ["session/load"])

    async def test_disconnected_state_read_reconnects_without_prompt_or_executor_restart(self):
        class ClientError(Exception): pass
        class RpcError(ClientError): pass
        for fault in ("disconnect", "native-error", "active", "other-owner"):
            with self.subTest(fault=fault), tempfile.TemporaryDirectory() as directory:
                c = host.Controller.__new__(host.Controller)
                c.home = Path(directory).resolve()
                (c.home / "gateway.lock").write_text(json.dumps({"pid": 12 if fault != "other-owner" else 13, "hermes_home": directory}))
                c.active, c.prompt_pending = ({"prompt": "accepted"} if fault == "active" else None), False
                c.gateway = types.SimpleNamespace(pid=12, returncode=None)
                c.gateway_reader = None
                c.tasks = set()
                c.gateway_events = AsyncMock()
                c.native, c.stop, c.start = AsyncMock(), AsyncMock(), AsyncMock()
                c.rpc = types.SimpleNamespace(rpc=AsyncMock(side_effect=RpcError() if fault == "native-error" else ClientError()))
                c.rpc_context = types.SimpleNamespace(__aexit__=AsyncMock())
                fresh = types.SimpleNamespace(rpc=AsyncMock(return_value={"session_id": "original"}))
                connect = Mock(return_value=types.SimpleNamespace(__aenter__=AsyncMock(return_value=fresh)))
                modules = {"hermes_cli.gateway_client": types.SimpleNamespace(GatewayClientError=ClientError, GatewayRPCError=RpcError, connect_gateway=connect),
                           "hermes_cli.gateway_runtime": types.SimpleNamespace(attachable=lambda _: True,
                           discover_gateway_endpoint=lambda _: types.SimpleNamespace(endpoint=types.SimpleNamespace(supervisor="external")))}
                with patch.dict(sys.modules, modules):
                    if fault == "disconnect":
                        self.assertEqual(await c.read_snapshot("original"), {"session_id": "original"})
                        self.assertEqual(connect.call_count, 1)
                    else:
                        with self.assertRaises(Exception): await c.read_snapshot("original")
                        connect.assert_not_called()
                c.native.assert_not_called(); c.stop.assert_not_called(); c.start.assert_not_called()
                await asyncio.gather(*c.tasks)

    def test_binding_keeps_native_home_when_launch_environment_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            first, second, storage = root / "first", root / "second", root / "storage"
            first.mkdir(); second.mkdir()
            dependencies = root / "dependencies"
            dependencies.mkdir()
            (first / "installs").symlink_to(dependencies, target_is_directory=True)
            (first / "config.yaml").write_text('{"agent":{"system_prompt":"original-profile"}}')
            (second / "config.yaml").write_text('{"agent":{"system_prompt":"different-profile"}}')
            modules = {"dotenv": types.SimpleNamespace(dotenv_values=lambda _: {}),
                       "hermes_cli": types.SimpleNamespace(__file__=str(root / "package/hermes_cli/__init__.py"))}
            with patch.dict(sys.modules, modules), patch.object(host, "yaml", types.SimpleNamespace(safe_load=json.loads, safe_dump=lambda value, **_: json.dumps(value))):
                for source in (first, second, second):
                    with patch.dict(os.environ, {"HERMES_HOME": str(source), "ROVAI_HERMES_STORAGE": str(storage)}):
                        home, lock = host.prepare_home()
                        try:
                            self.assertEqual(home, storage / "native-home")
                            self.assertEqual(json.loads((home / "config.yaml").read_text())["agent"]["system_prompt"], "original-profile")
                            self.assertEqual(json.loads((storage / "native-source.json").read_text()), {"home": str(first), "profile": "default"})
                        finally: lock.close()
                    # Legacy storage has no marker and can contain a symlink
                    # to a Home whose installs is itself another symlink.
                    (storage / "native-source.json").unlink()
                    (home / "state.db").touch()
                (home / "installs").unlink()
                (home / "auth.json").write_text('{}')
                with patch.dict(os.environ, {"HERMES_HOME": str(second), "ROVAI_HERMES_STORAGE": str(storage)}):
                    home, lock = host.prepare_home()
                    try:
                        self.assertEqual(json.loads((home / "config.yaml").read_text())["agent"]["system_prompt"], "original-profile")
                        self.assertEqual(json.loads((storage / "native-source.json").read_text())["home"], str(home))
                        self.assertFalse((home / "auth.lock").is_symlink())
                    finally: lock.close()


if __name__ == "__main__":
    unittest.main()
