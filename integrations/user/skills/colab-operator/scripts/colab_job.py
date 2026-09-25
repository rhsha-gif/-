#!/usr/bin/env python3
"""colab_job: run one file-shaped Python job on a fresh Google Colab runtime.

One manifest (job.json) drives the whole pipeline: allocate a session (trying
accelerator candidates in order), install packages, upload inputs, launch the
script detached on the VM, poll, download outputs, stop the session, and write
a machine-readable receipt. The pipeline is resumable: `run` returns after
--max-wait seconds with status "running" and a later `run`/`wait`/`collect`
continues from the saved state, so a headless worker whose shell tool has a
time limit can keep calling it.

Standard library only. Progress goes to stderr, the receipt JSON to stdout.

Exit codes: 0 ok, 1 failed/blocked/aborted, 2 still running (call again),
3 finished but the session could not be stopped (manual `colab stop`).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

ACCELERATORS = {"T4", "L4", "G4", "H100", "A100"}
TPUS = {"v5e1", "v6e1"}
CPU = "cpu"
REMOTE_ROOT = "/content/.aorch-job"
MARK_START = "AORCHJOB"
MARK_END = "AORCHJOB_END"
PHASES = ["new", "install", "upload", "launch", "wait", "collect", "done"]

TEMPLATE = {
    "name": "example",
    "accelerators": ["T4", "cpu"],
    "high_mem": False,
    "packages": [],
    "requirements": None,
    "wheels_dir": None,
    "uploads": [{"local": "input/data.csv", "remote": "/content/data.csv"}],
    "script": "job.py",
    "args": [],
    "env": {},
    "timeout_minutes": 30,
    "poll_seconds": 20,
    "outputs": [{"remote": "/content/out", "local": "out"}],
    "keep_on_failure": False,
    "session_prefix": "aorch",
}


class JobError(Exception):
    """A failure that ends the job; the message is user-facing."""


SECRET_PATTERNS = [
    re.compile(r"(colab-runtime-proxy-token=)[^&\s\"']+"),
    re.compile(r"(Bearer\s+)[A-Za-z0-9._-]{16,}"),
    re.compile(r"(eyJ[A-Za-z0-9_-]{10,}\.)[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
]


def redact(text: str) -> str:
    """Strip runtime proxy tokens and JWT-looking strings before anything is
    stored in the receipt; the CLI echoes them in error URLs."""
    for pattern in SECRET_PATTERNS:
        text = pattern.sub(lambda m: m.group(1) + "<redacted>", text)
    return text


def log(message: str) -> None:
    print(f"[colab_job] {message}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------- manifest

def load_manifest(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise JobError(f"cannot read manifest {path}: {error}") from error
    if not isinstance(data, dict):
        raise JobError("manifest must be a JSON object")
    manifest = {**TEMPLATE, **data}
    name = manifest.get("name")
    if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,40}", name):
        raise JobError("manifest.name must be a short path-safe identifier")
    accelerators = manifest.get("accelerators")
    if not isinstance(accelerators, list) or not accelerators:
        raise JobError("manifest.accelerators must be a non-empty list (use [\"cpu\"] for CPU)")
    for item in accelerators:
        if item not in ACCELERATORS and item not in TPUS and item != CPU:
            raise JobError(f"unknown accelerator {item!r}; allowed: {sorted(ACCELERATORS | TPUS)} or 'cpu'")
    if not isinstance(manifest.get("script"), str) or not manifest["script"]:
        raise JobError("manifest.script is required")
    for key in ("packages", "args", "uploads", "outputs"):
        if not isinstance(manifest.get(key), list):
            raise JobError(f"manifest.{key} must be a list")
    if not isinstance(manifest.get("env"), dict):
        raise JobError("manifest.env must be an object")
    for entry in manifest["uploads"] + manifest["outputs"]:
        if not isinstance(entry, dict) or not entry.get("local") or not entry.get("remote"):
            raise JobError("every uploads/outputs entry needs local and remote")
        if not str(entry["remote"]).startswith("/"):
            raise JobError(f"remote path must be absolute: {entry['remote']}")
    if not (isinstance(manifest.get("timeout_minutes"), (int, float)) and manifest["timeout_minutes"] > 0):
        raise JobError("manifest.timeout_minutes must be a positive number")
    if not (isinstance(manifest.get("poll_seconds"), (int, float)) and manifest["poll_seconds"] >= 1):
        raise JobError("manifest.poll_seconds must be >= 1")
    return manifest


# ---------------------------------------------------------------- colab CLI

def cli_command() -> list[str]:
    """The colab executable. COLAB_JOB_CLI overrides it (tests use a fake)."""
    override = os.environ.get("COLAB_JOB_CLI")
    if override:
        # A JSON list, or a POSIX-quoted string; backslashes become slashes so a
        # Windows path survives shlex (Windows accepts forward slashes).
        if override.lstrip().startswith("["):
            return [str(part) for part in json.loads(override)]
        return shlex.split(override.replace("\\", "/"))
    found = shutil.which("colab")
    if not found:
        raise JobError("colab CLI not found on PATH (on Windows the WSL shim ~/.local/bin/colab.cmd)")
    return [found]


def cli_path(local: str, root: Path) -> str:
    """A local path as the colab CLI expects it: relative to the job root when
    possible, otherwise WSL form on Windows (/mnt/c/...)."""
    candidate = Path(local)
    if not candidate.is_absolute():
        return candidate.as_posix()
    try:
        return candidate.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        pass
    if os.name == "nt":
        drive, rest = os.path.splitdrive(str(candidate.resolve()))
        return f"/mnt/{drive[0].lower()}{rest.replace(os.sep, '/')}"
    return candidate.as_posix()


def command_line(base: list[str], args: tuple[str, ...] | list[str]):
    """argv for subprocess, or a pre-quoted string when the CLI is a Windows
    .cmd/.bat shim: cmd.exe re-parses %*, so `mineru>=4.0,<5` would become a
    redirection unless every argument is wrapped in double quotes."""
    if os.name == "nt" and base and base[-1].lower().endswith((".cmd", ".bat")):
        quoted = [subprocess.list2cmdline([part]) for part in base]
        quoted += ['"' + str(arg).replace('"', '""') + '"' for arg in args]
        return " ".join(quoted)
    return [*base, *args]


class Colab:
    def __init__(self, root: Path, state: "State") -> None:
        self.root = root
        self.state = state
        self.base = cli_command()

    def run(self, *args: str, stdin: str | None = None, check: bool = False, timeout: float = 600.0) -> subprocess.CompletedProcess:
        started = time.monotonic()
        try:
            result = subprocess.run(
                command_line(self.base, args), input=stdin, capture_output=True, text=True, encoding="utf-8", errors="replace",
                cwd=str(self.root), timeout=timeout,
            )
        except subprocess.TimeoutExpired as error:
            self.state.record_command(args, None, time.monotonic() - started)
            raise JobError(f"colab {args[0]} exceeded {timeout:.0f}s") from error
        self.state.record_command(args, result.returncode, time.monotonic() - started)
        if check and result.returncode != 0:
            raise JobError(f"colab {' '.join(args[:3])} failed ({result.returncode}): {redact((result.stderr or result.stdout).strip())[-800:]}")
        return result

    def exec_json(self, session: str, code: str) -> dict:
        """Run Python on the VM and parse the MARK_START{json}MARK_END it prints."""
        result = self.run("exec", "-s", session, stdin=code, timeout=300.0)
        combined = f"{result.stdout}\n{result.stderr}"
        match = re.search(re.escape(MARK_START) + r"(\{.*?\})" + re.escape(MARK_END), combined, re.DOTALL)
        if not match:
            raise JobError(f"no structured reply from the VM (exit {result.returncode}): {redact(combined.strip())[-800:]}")
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError as error:
            raise JobError(f"unparseable VM reply: {error}") from error


# ---------------------------------------------------------------- state

class State:
    def __init__(self, path: Path, manifest: dict) -> None:
        self.path = path
        self.data = {
            "name": manifest["name"],
            "job_id": None,
            "session": None,
            "phase": "new",
            "status": "pending",
            "accelerator_requested": list(manifest["accelerators"]),
            "accelerator_used": None,
            "attempts": [],
            "timings": {},
            "commands": [],
            "launched_at": None,
            "exit_code": None,
            "log_tail": "",
            "gpu": None,
            "outputs": [],
            "unresolved": [],
            "error": None,
        }
        if path.exists():
            try:
                saved = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(saved, dict) and saved.get("name") == manifest["name"]:
                    self.data.update(saved)
            except (OSError, json.JSONDecodeError):
                pass

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.path)

    def record_command(self, args: tuple[str, ...], exit_code: int | None, seconds: float) -> None:
        shown = ["colab", *(a if len(a) < 120 else a[:117] + "..." for a in args)]
        self.data["commands"].append({"argv": shown, "exit_code": exit_code, "seconds": round(seconds, 2)})

    def time(self, key: str, seconds: float) -> None:
        self.data["timings"][key] = round(self.data["timings"].get(key, 0) + seconds, 2)

    def receipt(self) -> dict:
        keys = ["name", "status", "session", "accelerator_requested", "accelerator_used", "attempts", "timings",
                "exit_code", "log_tail", "gpu", "outputs", "commands", "unresolved", "error"]
        return {key: self.data.get(key) for key in keys}


# ---------------------------------------------------------------- phases

class Job:
    def __init__(self, manifest_path: Path, state_dir: Path | None = None) -> None:
        self.manifest_path = manifest_path.resolve()
        self.root = self.manifest_path.parent
        self.manifest = load_manifest(self.manifest_path)
        self.state_dir = (state_dir or (self.root / ".colab-job" / self.manifest["name"])).resolve()
        self.state = State(self.state_dir / "state.json", self.manifest)
        self.colab = Colab(self.root, self.state)
        self.receipt_path = self.state_dir / "job-receipt.json"

    # -- helpers
    @property
    def session(self) -> str:
        return self.state.data["session"]

    @property
    def remote_dir(self) -> str:
        return f"{REMOTE_ROOT}/{self.state.data['job_id']}"

    def write_receipt(self) -> dict:
        self.state.save()
        receipt = self.state.receipt()
        self.receipt_path.parent.mkdir(parents=True, exist_ok=True)
        self.receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2), encoding="utf-8")
        return receipt

    def stop_session(self, reason: str) -> bool:
        session = self.session
        if not session:
            return True
        started = time.monotonic()
        result = self.colab.run("stop", "-s", session, timeout=180.0)
        self.state.time("stop", time.monotonic() - started)
        if result.returncode != 0:
            self.state.data["unresolved"].append(f"colab stop -s {session} failed ({reason}): {redact((result.stderr or result.stdout).strip())[-300:]}")
            return False
        log(f"session {session} stopped ({reason})")
        return True

    # -- new
    def phase_new(self) -> None:
        if self.state.data["job_id"] is None:
            self.state.data["job_id"] = f"{self.manifest['name']}-{secrets.token_hex(3)}"
        tried = {attempt["accelerator"] for attempt in self.state.data["attempts"]}
        for accelerator in self.manifest["accelerators"]:
            if accelerator in tried:
                continue
            session = f"{self.manifest['session_prefix']}-{self.state.data['job_id']}"
            args = ["new", "-s", session]
            if accelerator in ACCELERATORS:
                args += ["--gpu", accelerator]
            elif accelerator in TPUS:
                args += ["--tpu", accelerator]
            if self.manifest["high_mem"]:
                args.append("--high-mem")
            log(f"allocating {accelerator} session {session}")
            started = time.monotonic()
            result = self.colab.run(*args, timeout=600.0)
            elapsed = time.monotonic() - started
            self.state.time("new", elapsed)
            text = redact(f"{result.stdout}\n{result.stderr}".strip())
            if result.returncode == 0 and "rejected" not in text.lower():
                self.state.data["attempts"].append({"accelerator": accelerator, "ok": True, "seconds": round(elapsed, 2)})
                self.state.data["session"] = session
                self.state.data["accelerator_used"] = accelerator
                self.state.data["phase"] = "install"
                self.state.save()
                return
            self.state.data["attempts"].append({"accelerator": accelerator, "ok": False, "seconds": round(elapsed, 2), "message": text[-400:]})
            self.state.save()
            log(f"{accelerator} rejected: {text[-200:]}")
            # The CLI unassigns a rejected VM itself; a stop here only guards a half-created one.
            self.colab.run("stop", "-s", session, timeout=120.0)
        raise JobError("every accelerator candidate was rejected: " + ", ".join(self.manifest["accelerators"]))

    # -- install
    def phase_install(self) -> None:
        started = time.monotonic()
        wheels_dir = self.manifest.get("wheels_dir")
        if wheels_dir:
            wheel_root = (self.root / wheels_dir).resolve()
            wheels = sorted(wheel_root.glob("*.whl"))
            if not wheels:
                raise JobError(f"wheels_dir {wheels_dir} contains no *.whl")
            for wheel in wheels:
                log(f"uploading wheel {wheel.name}")
                self.colab.run("upload", "-s", self.session, cli_path(str(wheel), self.root), f"/content/wheels/{wheel.name}", check=True, timeout=900.0)
            self.colab.exec_json(self.session, self.py_shell(
                "python3 -m pip install --quiet --no-index --find-links /content/wheels /content/wheels/*.whl"))
        if self.manifest["packages"]:
            log(f"installing {len(self.manifest['packages'])} package(s)")
            self.colab.run("install", "-s", self.session, *self.manifest["packages"], check=True, timeout=1800.0)
        if self.manifest.get("requirements"):
            log("installing requirements file")
            self.colab.run("install", "-s", self.session, "-r", cli_path(self.manifest["requirements"], self.root), check=True, timeout=1800.0)
        self.state.time("install", time.monotonic() - started)
        self.state.data["phase"] = "upload"
        self.state.save()

    # -- upload
    def ensure_remote_dirs(self, remote_files: list[str]) -> None:
        """The contents API returns 500 when the parent directory is missing."""
        dirs = sorted({file.rsplit("/", 1)[0] for file in remote_files if "/" in file.strip("/")})
        code = (
            "import json, os\n"
            f"for d in {dirs!r}:\n"
            "    os.makedirs(d, exist_ok=True)\n"
            f"print({MARK_START!r} + json.dumps({{'dirs': {dirs!r}}}) + {MARK_END!r})\n"
        )
        self.colab.exec_json(self.session, code)

    def phase_upload(self) -> None:
        started = time.monotonic()
        script = (self.root / self.manifest["script"]).resolve()
        if not script.is_file():
            raise JobError(f"script not found: {script}")
        transfers: list[tuple[Path, str]] = []
        for entry in self.manifest["uploads"]:
            local = (self.root / entry["local"]).resolve()
            if not local.exists():
                raise JobError(f"upload source missing: {local}")
            if local.is_dir():
                for file in sorted(p for p in local.rglob("*") if p.is_file()):
                    transfers.append((file, entry["remote"].rstrip("/") + "/" + file.relative_to(local).as_posix()))
            else:
                transfers.append((local, entry["remote"]))
        transfers.append((script, f"{self.remote_dir}/script.py"))
        self.ensure_remote_dirs([remote for _, remote in transfers])
        for local, remote in transfers:
            shown = local.relative_to(self.root).as_posix() if local.is_relative_to(self.root) else str(local)
            log(f"uploading {shown} -> {remote}")
            self.colab.run("upload", "-s", self.session, cli_path(str(local), self.root), remote, check=True, timeout=1800.0)
        self.state.time("upload", time.monotonic() - started)
        self.state.data["phase"] = "launch"
        self.state.save()

    # -- launch
    def py_shell(self, command: str) -> str:
        """Python for `colab exec` that runs one shell command and reports it."""
        return (
            "import json, subprocess\n"
            f"r = subprocess.run({command!r}, shell=True, capture_output=True, text=True)\n"
            f"print({MARK_START!r} + json.dumps({{'exit': r.returncode, 'out': (r.stdout + r.stderr)[-1500:]}}) + {MARK_END!r})\n"
        )

    def phase_launch(self) -> None:
        remote = self.remote_dir
        exports = "".join(f"export {key}={shlex.quote(str(value))}\n" for key, value in self.manifest["env"].items())
        args = " ".join(shlex.quote(str(arg)) for arg in self.manifest["args"])
        run_sh = (
            "#!/bin/bash\n"
            f"J={remote}\n"
            "cd /content\n"
            f"{exports}"
            "date +%s > $J/t_start\n"
            f"python3 $J/script.py {args} > $J/job.log 2>&1\n"
            "code=$?\n"
            "date +%s > $J/t_end\n"
            "echo $code > $J/exit\n"
        )
        code = (
            "import json, os, subprocess\n"
            f"J = {remote!r}\n"
            "os.makedirs(J, exist_ok=True)\n"
            f"open(J + '/run.sh', 'w').write({run_sh!r})\n"
            "p = subprocess.Popen(['bash', J + '/run.sh'], stdout=open(J + '/nohup.out', 'w'), stderr=subprocess.STDOUT, start_new_session=True)\n"
            f"print({MARK_START!r} + json.dumps({{'pid': p.pid}}) + {MARK_END!r})\n"
        )
        started = time.monotonic()
        reply = self.colab.exec_json(self.session, code)
        self.state.time("launch", time.monotonic() - started)
        self.state.data["launched_at"] = time.time()
        self.state.data["phase"] = "wait"
        self.state.data["status"] = "running"
        self.state.save()
        log(f"launched pid {reply.get('pid')} in {remote}")

    # -- wait
    def poll_once(self) -> dict:
        remote = self.remote_dir
        code = (
            "import json, os, subprocess\n"
            f"J = {remote!r}\n"
            "def rd(p):\n"
            "    try:\n"
            "        return open(p).read().strip()\n"
            "    except Exception:\n"
            "        return None\n"
            "try:\n"
            "    gpu = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.used,utilization.gpu', '--format=csv,noheader'], capture_output=True, text=True, timeout=20).stdout.strip()\n"
            "except Exception:\n"
            "    gpu = None\n"
            "log = rd(J + '/job.log') or ''\n"
            f"print({MARK_START!r} + json.dumps({{'exit': rd(J + '/exit'), 't_start': rd(J + '/t_start'), 't_end': rd(J + '/t_end'), 'log_tail': log[-1500:], 'gpu': gpu}}) + {MARK_END!r})\n"
        )
        return self.colab.exec_json(self.session, code)

    def phase_wait(self, max_wait: float) -> bool:
        """Poll until the job exits. Returns True when finished, False on max-wait."""
        deadline = time.monotonic() + max_wait
        timeout_at = (self.state.data["launched_at"] or time.time()) + self.manifest["timeout_minutes"] * 60
        while True:
            reply = self.poll_once()
            self.state.data["log_tail"] = reply.get("log_tail") or ""
            if reply.get("gpu"):
                self.state.data["gpu"] = reply["gpu"]
            if reply.get("exit") is not None:
                try:
                    self.state.data["exit_code"] = int(reply["exit"])
                except ValueError:
                    self.state.data["exit_code"] = 1
                try:
                    self.state.time("run", int(reply["t_end"]) - int(reply["t_start"]))
                except (TypeError, ValueError):
                    pass
                self.state.data["phase"] = "collect"
                self.state.save()
                log(f"job exited with {self.state.data['exit_code']}")
                return True
            self.state.save()
            if time.time() > timeout_at:
                raise JobError(f"job exceeded timeout_minutes={self.manifest['timeout_minutes']}")
            if time.monotonic() + self.manifest["poll_seconds"] > deadline:
                return False
            time.sleep(self.manifest["poll_seconds"])

    # -- collect
    def list_remote(self, remote: str) -> list[str]:
        code = (
            "import json, os\n"
            f"R = {remote!r}\n"
            "files = []\n"
            "if os.path.isfile(R):\n"
            "    files = [R]\n"
            "elif os.path.isdir(R):\n"
            "    for base, _, names in os.walk(R):\n"
            "        files += [os.path.join(base, n) for n in names]\n"
            f"print({MARK_START!r} + json.dumps({{'files': sorted(files)}}) + {MARK_END!r})\n"
        )
        return list(self.colab.exec_json(self.session, code).get("files") or [])

    def phase_collect(self) -> None:
        started = time.monotonic()
        outputs = []
        for entry in self.manifest["outputs"]:
            remote = entry["remote"].rstrip("/") or entry["remote"]
            local_root = (self.root / entry["local"]).resolve()
            files = self.list_remote(remote)
            if not files:
                self.state.data["unresolved"].append(f"no files under {remote}")
                continue
            for file in files:
                rel = file[len(remote):].lstrip("/") if file != remote else ""
                local = local_root / rel if rel else local_root
                local.parent.mkdir(parents=True, exist_ok=True)
                log(f"downloading {file} -> {local.relative_to(self.root).as_posix() if local.is_relative_to(self.root) else local}")
                self.colab.run("download", "-s", self.session, file, cli_path(str(local), self.root), check=True, timeout=1800.0)
                outputs.append({"local": local.relative_to(self.root).as_posix() if local.is_relative_to(self.root) else str(local),
                                "bytes": local.stat().st_size if local.exists() else None})
        # The job's own log is always worth having next to the outputs.
        log_local = self.state_dir / "job.log"
        self.colab.run("download", "-s", self.session, f"{self.remote_dir}/job.log", cli_path(str(log_local), self.root), timeout=600.0)
        self.state.data["outputs"] = outputs
        self.state.time("download", time.monotonic() - started)
        self.state.data["status"] = "ok" if self.state.data["exit_code"] == 0 else "failed"
        if self.state.data["exit_code"] != 0:
            self.state.data["error"] = f"script exited with {self.state.data['exit_code']}"
        keep = self.manifest["keep_on_failure"] and self.state.data["status"] != "ok"
        if keep:
            self.state.data["unresolved"].append(f"session {self.session} kept for inspection (keep_on_failure); run `colab stop -s {self.session}`")
        else:
            self.stop_session("collect")  # a failure is recorded in unresolved
        self.state.data["phase"] = "done"
        self.state.save()

    # -- driver
    def fail(self, error: Exception) -> int:
        self.state.data["status"] = "blocked" if isinstance(error, JobError) and "rejected" in str(error) else "failed"
        self.state.data["error"] = redact(str(error))
        stopped = True
        if self.session and not self.manifest["keep_on_failure"]:
            stopped = self.stop_session("failure")
        elif self.session:
            self.state.data["unresolved"].append(f"session {self.session} kept for inspection (keep_on_failure); run `colab stop -s {self.session}`")
        self.state.data["phase"] = "done"
        receipt = self.write_receipt()
        print(json.dumps(receipt, ensure_ascii=False, indent=2))
        log(f"{self.state.data['status']}: {error}")
        return 3 if not stopped else 1

    def run(self, max_wait: float, dry_run: bool = False) -> int:
        if dry_run:
            print(json.dumps({"plan": self.dry_plan()}, ensure_ascii=False, indent=2))
            return 0
        if self.state.data["phase"] == "done":
            print(json.dumps(self.state.receipt(), ensure_ascii=False, indent=2))
            return 0 if self.state.data["status"] == "ok" and not self.state.data["unresolved"] else 1
        try:
            while self.state.data["phase"] != "done":
                phase = self.state.data["phase"]
                if phase == "new":
                    self.phase_new()
                elif phase == "install":
                    self.phase_install()
                elif phase == "upload":
                    self.phase_upload()
                elif phase == "launch":
                    self.phase_launch()
                elif phase == "wait":
                    if not self.phase_wait(max_wait):
                        receipt = self.write_receipt()
                        print(json.dumps(receipt, ensure_ascii=False, indent=2))
                        log(f"still running after max-wait {max_wait:.0f}s; call again to continue")
                        return 2
                elif phase == "collect":
                    self.phase_collect()
        except (JobError, OSError) as error:
            return self.fail(error)
        except KeyboardInterrupt:
            return self.fail(JobError("interrupted"))
        receipt = self.write_receipt()
        print(json.dumps(receipt, ensure_ascii=False, indent=2))
        if self.state.data["unresolved"]:
            return 3 if any("colab stop" in item and "failed" in item for item in self.state.data["unresolved"]) else 1
        return 0 if self.state.data["status"] == "ok" else 1

    def dry_plan(self) -> list[str]:
        steps = [f"new: try {' -> '.join(self.manifest['accelerators'])}"]
        if self.manifest.get("wheels_dir"):
            steps.append(f"install: wheels from {self.manifest['wheels_dir']}")
        if self.manifest["packages"]:
            steps.append(f"install: {', '.join(self.manifest['packages'])}")
        if self.manifest.get("requirements"):
            steps.append(f"install: -r {self.manifest['requirements']}")
        steps += [f"upload: {e['local']} -> {e['remote']}" for e in self.manifest["uploads"]]
        steps.append(f"launch: python3 {self.manifest['script']} {' '.join(map(str, self.manifest['args']))} (timeout {self.manifest['timeout_minutes']} min)")
        steps += [f"download: {e['remote']} -> {e['local']}" for e in self.manifest["outputs"]]
        steps.append("stop session")
        return steps

    def abort(self) -> int:
        if not self.session:
            log("no session recorded; nothing to abort")
            return 0
        stopped = self.stop_session("abort")
        self.state.data["status"] = "aborted"
        self.state.data["phase"] = "done"
        self.write_receipt()
        return 0 if stopped else 3


# ---------------------------------------------------------------- verify

def verify(receipt_path: Path) -> int:
    try:
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"verify: cannot read receipt: {error}")
        return 1
    problems = []
    if receipt.get("status") != "ok":
        problems.append(f"status is {receipt.get('status')!r}, not ok")
    if receipt.get("unresolved"):
        problems.append(f"unresolved: {receipt['unresolved']}")
    root = receipt_path.resolve().parents[2] if len(receipt_path.resolve().parents) >= 3 else receipt_path.resolve().parent
    for output in receipt.get("outputs") or []:
        local = Path(output["local"])
        if not local.is_absolute():
            local = root / local
        if not local.is_file() or local.stat().st_size == 0:
            problems.append(f"output missing or empty: {output['local']}")
    if not receipt.get("outputs"):
        problems.append("no outputs recorded")
    session = receipt.get("session")
    if session:
        try:
            result = subprocess.run(command_line(cli_command(), ["sessions"]), capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
            if session in f"{result.stdout}{result.stderr}":
                problems.append(f"session {session} is still allocated")
        except (JobError, OSError, subprocess.TimeoutExpired) as error:
            problems.append(f"could not list sessions: {error}")
    if problems:
        for problem in problems:
            print(f"verify: {problem}")
        return 1
    print(f"verify: ok ({len(receipt.get('outputs') or [])} output file(s), session {session} released)")
    return 0


# ---------------------------------------------------------------- main

def main(argv: list[str] | None = None) -> int:
    # Receipts carry Korean log tails; a cp949 console must not crash the run.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (ValueError, OSError):
                pass
    parser = argparse.ArgumentParser(prog="colab_job", description=(__doc__ or "").split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("template", help="print an example manifest")
    for name, help_text in (("run", "run the whole pipeline (resumable)"), ("wait", "only poll a launched job"), ("collect", "download outputs and stop")):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("manifest", type=Path)
        p.add_argument("--max-wait", type=float, default=480.0, help="seconds to wait for the job in this call (default 480)")
        p.add_argument("--state", type=Path, default=None, help="state directory (default .colab-job/<name> next to the manifest)")
        if name == "run":
            p.add_argument("--dry-run", action="store_true")
    p = sub.add_parser("abort", help="stop the job's session")
    p.add_argument("manifest", type=Path)
    p.add_argument("--state", type=Path, default=None)
    p = sub.add_parser("verify", help="check a receipt: status ok, outputs present, session released")
    p.add_argument("receipt", type=Path)
    args = parser.parse_args(argv)

    if args.command == "template":
        print(json.dumps(TEMPLATE, ensure_ascii=False, indent=2))
        return 0
    if args.command == "verify":
        return verify(args.receipt)
    try:
        job = Job(args.manifest, args.state)
    except JobError as error:
        log(str(error))
        return 1
    if args.command == "abort":
        return job.abort()
    if args.command in ("wait", "collect") and job.state.data["phase"] in ("new", "install", "upload", "launch"):
        log(f"job is in phase {job.state.data['phase']}; use run")
        return 1
    if args.command == "collect" and job.state.data["phase"] == "wait":
        # Collect means "do not wait any longer": one poll, then download or report running.
        return job.run(max_wait=0)
    return job.run(max_wait=args.max_wait, dry_run=getattr(args, "dry_run", False))


if __name__ == "__main__":
    sys.exit(main())
