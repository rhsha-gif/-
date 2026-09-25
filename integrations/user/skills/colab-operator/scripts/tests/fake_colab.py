#!/usr/bin/env python3
"""A stand-in for the `colab` CLI used by the colab_job tests.

Behaviour is driven by a scenario JSON file (FAKE_COLAB_SCENARIO) and every
invocation is appended to a log (FAKE_COLAB_LOG) so tests can assert on the
exact command sequence. Sessions and the remote job directory live in a small
JSON "VM" file (FAKE_COLAB_VM) so state survives across invocations.

Scenario keys:
  reject: list of accelerators `new --gpu X` rejects (exit 1, "rejected accelerator")
  polls_until_exit: how many poll execs return "still running" before the job exits
  exit_code: the job's exit code once finished (default 0)
  stop_fails: make `colab stop` exit 1
  remote_files: files that exist under the outputs remote after the job ran
"""
import json
import os
import sys
from pathlib import Path

MARK_START = "AORCHJOB"
MARK_END = "AORCHJOB_END"


def load(path, default):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return default


def save(path, data):
    Path(path).write_text(json.dumps(data), encoding="utf-8")


def main(argv):
    scenario = load(os.environ.get("FAKE_COLAB_SCENARIO"), {})
    vm_path = os.environ.get("FAKE_COLAB_VM")
    vm = load(vm_path, {"sessions": [], "polls": 0, "launched": False})
    with open(os.environ["FAKE_COLAB_LOG"], "a", encoding="utf-8") as log:
        log.write(json.dumps(argv) + "\n")
    command = argv[0] if argv else ""
    stdin = sys.stdin.read() if not sys.stdin.isatty() and command == "exec" else ""

    def session_arg():
        return argv[argv.index("-s") + 1] if "-s" in argv else None

    if command == "new":
        accelerator = argv[argv.index("--gpu") + 1] if "--gpu" in argv else (argv[argv.index("--tpu") + 1] if "--tpu" in argv else "cpu")
        if accelerator in scenario.get("reject", []):
            print(f"[colab] Backend rejected accelerator '{accelerator}'. You may not have quota or entitlement.", file=sys.stderr)
            return 1
        vm["sessions"].append(session_arg())
        save(vm_path, vm)
        print(f"[colab] Session READY ({session_arg()}).")
        return 0
    if command == "sessions":
        if vm["sessions"]:
            for name in vm["sessions"]:
                print(f"[{name}] gpu-fake | Hardware: T4")
        else:
            print("[colab] No active sessions found on server.")
        return 0
    if command == "stop":
        if scenario.get("stop_fails"):
            print("[colab] stop failed", file=sys.stderr)
            return 1
        vm["sessions"] = [s for s in vm["sessions"] if s != session_arg()]
        save(vm_path, vm)
        print("[colab] Session terminated.")
        return 0
    if command in ("install", "upload"):
        if session_arg() not in vm["sessions"]:
            print("[colab] Session not found", file=sys.stderr)
            return 1
        if command == "upload":
            vm.setdefault("uploads", []).append(argv[-1])
            save(vm_path, vm)
        return 0
    if command == "download":
        remote, local = argv[-2], argv[-1]
        Path(local).parent.mkdir(parents=True, exist_ok=True)
        Path(local).write_text(f"content of {remote}\n", encoding="utf-8")
        return 0
    if command == "exec":
        if session_arg() not in vm["sessions"]:
            print("[colab] Session not found", file=sys.stderr)
            return 1
        if "Popen(['bash'" in stdin:
            vm["launched"] = True
            save(vm_path, vm)
            print(MARK_START + json.dumps({"pid": 4242}) + MARK_END)
            return 0
        if "'/exit'" in stdin:  # poll
            vm["polls"] += 1
            save(vm_path, vm)
            done = vm["polls"] > scenario.get("polls_until_exit", 1)
            reply = {"exit": str(scenario.get("exit_code", 0)) if done else None,
                     "t_start": "1000", "t_end": "1085" if done else None,
                     "log_tail": "line 1\nline 2\n", "gpu": "Tesla T4, 900 MiB, 50 %"}
            print("noise before " + MARK_START + json.dumps(reply) + MARK_END + " noise after")
            return 0
        if "os.walk(R)" in stdin:  # list_remote
            files = scenario.get("remote_files", ["/content/out/result.json"])
            print(MARK_START + json.dumps({"files": files}) + MARK_END)
            return 0
        if "pip install" in stdin:
            print(MARK_START + json.dumps({"exit": 0, "out": "installed"}) + MARK_END)
            return 0
        if "os.makedirs(d, exist_ok=True)" in stdin:  # ensure_remote_dirs
            vm["mkdirs"] = vm.get("mkdirs", 0) + 1
            save(vm_path, vm)
            print(MARK_START + json.dumps({"dirs": []}) + MARK_END)
            return 0
        print("unknown exec", file=sys.stderr)
        return 1
    print(f"unknown command {command}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
