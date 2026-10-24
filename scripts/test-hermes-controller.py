"""Launcher and narrow control regressions; no Runtime or credentials."""
import asyncio
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


class DirectAcp(unittest.TestCase):
    def test_official_acp_owns_protocol_pipes_without_observation_connection(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory).resolve()
            (home / "gateway.lock").write_text(json.dumps({"pid": 42, "hermes_home": str(home)}))
            runtime = types.SimpleNamespace(
                attachable=lambda found: found is not None,
                discover_gateway_endpoint=Mock(side_effect=[None, types.SimpleNamespace(endpoint=types.SimpleNamespace(supervisor="external"))]))
            gateway = Mock(pid=42)
            gateway.poll.return_value = None
            with patch.dict(sys.modules, {"hermes_cli.gateway_runtime": runtime}), \
                 patch.dict(os.environ, {"ROVAI_HERMES_LAUNCHER": "/native/hermes"}), \
                 patch.object(host, "prepare_home", return_value=home), \
                 patch.object(host.subprocess, "Popen", return_value=gateway) as start, \
                 patch.object(host.runpy, "run_module") as official, patch.object(sys, "argv", []):
                host.serve()
                official.assert_called_once_with("hermes_cli.main", run_name="__main__", alter_sys=True)
                self.assertEqual(sys.argv, ["hermes", "--profile", "default", "acp"])
                self.assertEqual(start.call_count, 1)
                gateway.terminate.assert_called_once()


class OfficialControls(unittest.IsolatedAsyncioTestCase):
    async def test_unknown_recovery_is_exact_explicit_control_without_prompt(self):
        for case in ("inspect", "resolve", "terminal", "no_ack", "wrong_generation", "wrong_session",
                     "queued", "running", "approval", "multiple", "wrong_after"):
            with self.subTest(case=case):
                c = host.Control.__new__(host.Control)
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


    async def test_restore_state_only_defers_mcp_changes_for_real_native_blockers(self):
        for state, extra in (("idle", {}), ("running", {"running": True}),
                             ("approval", {"prompts": [{"id": "approval"}]}),
                             ("unknown", {"pending": [{"status": "unknown"}]}),
                             ("queued", {"pending": [{"status": "queued"}]})):
            with self.subTest(state=state):
                snapshot = {"session_id": "original", "revision": 1, "execution_generation": 2, **extra}
                rpc = AsyncMock(side_effect=[snapshot, {"mcp_servers": []}])
                c = host.Control(types.SimpleNamespace(rpc=rpc))
                result = await c.prepare_session({"sessionId": "original", "mcpServers": []})
                self.assertEqual(result, {"sessionId": "original", "state": state})
                self.assertEqual([call.args[0] for call in rpc.call_args_list],
                    ["session.resume"] + (["session.mutate"] if state == "idle" else []))
                if state == "idle":
                    self.assertEqual(rpc.call_args.kwargs["payload"], {"mcp_servers": []})

    async def test_steer_targets_native_generation_and_never_retries(self):
        for response in ({"status": "queued", "execution_generation": 7}, {"status": "rejected", "delivered": False}, ConnectionError("lost")):
            rpc = AsyncMock(side_effect=[{"session_id": "original", "running": True, "execution_generation": 7}, response])
            c = host.Control(types.SimpleNamespace(rpc=rpc))
            if isinstance(response, Exception):
                with self.assertRaises(ConnectionError):
                    await c.steer({"sessionId": "original", "text": "supplement"})
            else:
                self.assertEqual((await c.steer({"sessionId": "original", "text": "supplement"}))["accepted"], response.get("status") == "queued")
            self.assertEqual(rpc.call_args.kwargs["execution_generation"], 7)
            self.assertEqual([call.args[0] for call in rpc.call_args_list], ["session.resume", "session.steer"])

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
                        home = host.prepare_home()
                        self.assertEqual(home, storage / "native-home")
                        self.assertEqual(json.loads((home / "config.yaml").read_text())["agent"]["system_prompt"], "original-profile")
                        self.assertEqual(json.loads((storage / "native-source.json").read_text()), {"home": str(first), "profile": "default"})
                    # Legacy storage has no marker and can contain a symlink
                    # to a Home whose installs is itself another symlink.
                    (storage / "native-source.json").unlink()
                    (home / "state.db").touch()
                (home / "installs").unlink()
                (home / "auth.json").write_text('{}')
                with patch.dict(os.environ, {"HERMES_HOME": str(second), "ROVAI_HERMES_STORAGE": str(storage)}):
                    home = host.prepare_home()
                    self.assertEqual(json.loads((home / "config.yaml").read_text())["agent"]["system_prompt"], "original-profile")
                    self.assertEqual(json.loads((storage / "native-source.json").read_text())["home"], str(home))
                    self.assertFalse((home / "auth.lock").is_symlink())

if __name__ == "__main__":
    unittest.main()
