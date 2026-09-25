"""Tests for colab_job.py against the fake colab CLI (no network, no Colab)."""
import contextlib
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import colab_job  # noqa: E402

FAKE = HERE / "fake_colab.py"


class Harness:
    def __init__(self, scenario: dict, manifest: dict | None = None):
        self.dir = tempfile.TemporaryDirectory()
        self.root = Path(self.dir.name)
        (self.root / "input").mkdir()
        (self.root / "input" / "data.csv").write_text("a,b\n1,2\n", encoding="utf-8")
        (self.root / "job.py").write_text("print('hi')\n", encoding="utf-8")
        base = {
            "name": "t1",
            "accelerators": ["A100", "T4"],
            "packages": ["numpy"],
            "uploads": [{"local": "input/data.csv", "remote": "/content/data.csv"}],
            "script": "job.py",
            "args": ["--x", "1"],
            "env": {"MODE": "test"},
            "timeout_minutes": 5,
            "poll_seconds": 1,
            "outputs": [{"remote": "/content/out", "local": "out"}],
        }
        base.update(manifest or {})
        self.manifest = self.root / "job.json"
        self.manifest.write_text(json.dumps(base), encoding="utf-8")
        self.log = self.root / "calls.log"
        self.log.touch()
        self.scenario = self.root / "scenario.json"
        self.scenario.write_text(json.dumps(scenario), encoding="utf-8")
        self.vm = self.root / "vm.json"
        self.env = {
            "COLAB_JOB_CLI": json.dumps([sys.executable, str(FAKE)]),
            "FAKE_COLAB_LOG": str(self.log),
            "FAKE_COLAB_SCENARIO": str(self.scenario),
            "FAKE_COLAB_VM": str(self.vm),
        }

    def run(self, *argv: str) -> tuple[int, dict]:
        saved = {key: os.environ.get(key) for key in self.env}
        os.environ.update(self.env)
        out = io.StringIO()
        try:
            with contextlib.redirect_stdout(out):
                code = colab_job.main(list(argv))
        finally:
            for key, value in saved.items():
                if value is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = value
        text = out.getvalue().strip()
        try:
            return code, json.loads(text) if text else {}
        except json.JSONDecodeError:
            return code, {"stdout": text}

    def calls(self) -> list[list[str]]:
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines() if line.strip()]

    def receipt(self) -> dict:
        return json.loads((self.root / ".colab-job" / "t1" / "job-receipt.json").read_text(encoding="utf-8"))

    def close(self):
        self.dir.cleanup()


class ColabJobTests(unittest.TestCase):
    def test_rejected_accelerator_falls_back_and_the_job_completes(self):
        h = Harness({"reject": ["A100"], "polls_until_exit": 1})
        self.addCleanup(h.close)
        code, receipt = h.run("run", str(h.manifest), "--max-wait", "30")
        self.assertEqual(code, 0, receipt)
        self.assertEqual(receipt["status"], "ok")
        self.assertEqual(receipt["accelerator_used"], "T4")
        self.assertEqual([a["accelerator"] for a in receipt["attempts"]], ["A100", "T4"])
        self.assertFalse(receipt["attempts"][0]["ok"])
        calls = h.calls()
        news = [c for c in calls if c[0] == "new"]
        self.assertEqual([c[c.index("--gpu") + 1] for c in news], ["A100", "T4"])
        self.assertIn(["install", "-s", receipt["session"], "numpy"], calls)
        self.assertTrue(any(c[0] == "upload" and c[-1] == "/content/data.csv" for c in calls))
        self.assertTrue(any(c[0] == "upload" and c[-1].endswith("/script.py") for c in calls))
        self.assertEqual(calls[-1][:2], ["stop", "-s"])
        self.assertTrue((h.root / "out" / "result.json").is_file())
        self.assertEqual(receipt["outputs"][0]["local"], "out/result.json")
        self.assertEqual(receipt["timings"]["run"], 85)
        self.assertEqual(receipt["gpu"], "Tesla T4, 900 MiB, 50 %")
        # verify: status ok, outputs present, session released
        code, _ = h.run("verify", str(h.root / ".colab-job" / "t1" / "job-receipt.json"))
        self.assertEqual(code, 0)

    def test_max_wait_returns_running_and_a_second_run_resumes(self):
        h = Harness({"polls_until_exit": 2}, {"accelerators": ["T4"]})
        self.addCleanup(h.close)
        code, receipt = h.run("run", str(h.manifest), "--max-wait", "0")
        self.assertEqual(code, 2)
        self.assertEqual(receipt["status"], "running")
        first_calls = len(h.calls())
        self.assertNotIn("stop", [c[0] for c in h.calls()])
        code, receipt = h.run("run", str(h.manifest), "--max-wait", "30")
        self.assertEqual(code, 0, receipt)
        self.assertEqual(receipt["status"], "ok")
        later = h.calls()[first_calls:]
        # The resumed run neither re-allocates nor re-uploads; it only polls, downloads and stops.
        self.assertEqual({c[0] for c in later}, {"exec", "download", "stop"})
        # A third call just replays the finished receipt.
        code, again = h.run("run", str(h.manifest))
        self.assertEqual((code, again["status"]), (0, "ok"))

    def test_every_candidate_rejected_is_blocked_without_a_session(self):
        h = Harness({"reject": ["A100", "T4"]})
        self.addCleanup(h.close)
        code, receipt = h.run("run", str(h.manifest))
        self.assertEqual(code, 1)
        self.assertEqual(receipt["status"], "blocked")
        self.assertIsNone(receipt["session"])
        self.assertIn("rejected", receipt["error"])
        self.assertEqual(len([c for c in h.calls() if c[0] == "new"]), 2)

    def test_script_failure_still_stops_the_session_and_fails_verify(self):
        h = Harness({"exit_code": 3}, {"accelerators": ["T4"]})
        self.addCleanup(h.close)
        code, receipt = h.run("run", str(h.manifest), "--max-wait", "30")
        self.assertEqual(code, 1)
        self.assertEqual(receipt["status"], "failed")
        self.assertEqual(receipt["exit_code"], 3)
        self.assertEqual(h.calls()[-1][0], "stop")
        self.assertEqual(json.loads(h.vm.read_text())["sessions"], [])
        code, _ = h.run("verify", str(h.root / ".colab-job" / "t1" / "job-receipt.json"))
        self.assertEqual(code, 1)

    def test_keep_on_failure_leaves_the_session_and_says_so(self):
        h = Harness({"exit_code": 2}, {"accelerators": ["T4"], "keep_on_failure": True})
        self.addCleanup(h.close)
        code, receipt = h.run("run", str(h.manifest), "--max-wait", "30")
        self.assertEqual(code, 1)
        self.assertNotIn("stop", [c[0] for c in h.calls()])
        self.assertTrue(any("colab stop -s" in item for item in receipt["unresolved"]))

    def test_stop_failure_is_exit_3_with_the_session_named(self):
        h = Harness({"stop_fails": True}, {"accelerators": ["T4"]})
        self.addCleanup(h.close)
        code, receipt = h.run("run", str(h.manifest), "--max-wait", "30")
        self.assertEqual(code, 3)
        self.assertEqual(receipt["status"], "ok")
        self.assertTrue(any(receipt["session"] in item and "failed" in item for item in receipt["unresolved"]))
        code, _ = h.run("verify", str(h.root / ".colab-job" / "t1" / "job-receipt.json"))
        self.assertEqual(code, 1)

    def test_abort_stops_a_launched_job(self):
        h = Harness({"polls_until_exit": 5}, {"accelerators": ["T4"]})
        self.addCleanup(h.close)
        code, _ = h.run("run", str(h.manifest), "--max-wait", "0")
        self.assertEqual(code, 2)
        code, _ = h.run("abort", str(h.manifest))
        self.assertEqual(code, 0)
        self.assertEqual(h.receipt()["status"], "aborted")
        self.assertEqual(json.loads(h.vm.read_text())["sessions"], [])

    def test_dry_run_calls_nothing(self):
        h = Harness({})
        self.addCleanup(h.close)
        code, plan = h.run("run", str(h.manifest), "--dry-run")
        self.assertEqual(code, 0)
        self.assertTrue(plan["plan"][0].startswith("new: try A100 -> T4"))
        self.assertEqual(h.calls(), [])

    def test_manifest_validation_rejects_unknown_accelerator_and_relative_remote(self):
        h = Harness({}, {"accelerators": ["RTX"]})
        self.addCleanup(h.close)
        with self.assertRaises(colab_job.JobError):
            colab_job.load_manifest(h.manifest)
        h.manifest.write_text(json.dumps({**json.loads(h.manifest.read_text()), "accelerators": ["cpu"], "outputs": [{"remote": "out", "local": "out"}]}), encoding="utf-8")
        with self.assertRaises(colab_job.JobError):
            colab_job.load_manifest(h.manifest)

    def test_cpu_candidate_allocates_without_a_gpu_flag(self):
        h = Harness({"reject": ["T4"]}, {"accelerators": ["T4", "cpu"]})
        self.addCleanup(h.close)
        code, receipt = h.run("run", str(h.manifest), "--max-wait", "30")
        self.assertEqual(code, 0, receipt)
        self.assertEqual(receipt["accelerator_used"], "cpu")
        cpu_new = [c for c in h.calls() if c[0] == "new"][-1]
        self.assertNotIn("--gpu", cpu_new)

    def test_template_is_valid_json(self):
        h = Harness({})
        self.addCleanup(h.close)
        code, template = h.run("template")
        self.assertEqual(code, 0)
        self.assertEqual(template["accelerators"], ["T4", "cpu"])

    def test_cli_path_converts_windows_absolute_paths_outside_the_root(self):
        root = Path(tempfile.gettempdir())
        if os.name == "nt":
            self.assertEqual(colab_job.cli_path(r"D:\data\x.csv", root), "/mnt/d/data/x.csv")
        self.assertEqual(colab_job.cli_path("input/x.csv", root), "input/x.csv")


if __name__ == "__main__":
    unittest.main()


class CommandLineTests(unittest.TestCase):
    def test_cmd_shim_arguments_are_quoted_against_redirection(self):
        line = colab_job.command_line([r"C:\Users\x\.local\bin\colab.cmd"], ["install", "-s", "s1", "mineru[torch]>=4.0,<5"])
        if os.name == "nt":
            self.assertEqual(line, r'C:\Users\x\.local\bin\colab.cmd "install" "-s" "s1" "mineru[torch]>=4.0,<5"')
        else:
            self.assertEqual(line, [r"C:\Users\x\.local\bin\colab.cmd", "install", "-s", "s1", "mineru[torch]>=4.0,<5"])

    def test_plain_executables_keep_argv_form(self):
        self.assertEqual(colab_job.command_line(["/usr/bin/colab"], ["sessions"]), ["/usr/bin/colab", "sessions"])


class RedactTests(unittest.TestCase):
    def test_runtime_proxy_tokens_and_jwts_are_redacted(self):
        text = "500 for url: https://x.colab.dev/api?authuser=0&colab-runtime-proxy-token=eyJhbGciOiJFUzI1NiIsImtpZCI6IlhGNEJ3dyJ9.eyJhdWQiOiJncHUifQ.aEMGxyiMUCTPEsz8pEuRSTz6kA end"
        out = colab_job.redact(text)
        self.assertNotIn("eyJhbGci", out)
        self.assertIn("colab-runtime-proxy-token=<redacted>", out)
        self.assertTrue(out.endswith(" end"))
