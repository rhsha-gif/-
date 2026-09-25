---
name: colab-operator
description: "Run a file-shaped Python job on a Google Colab runtime (CPU/GPU/TPU) through the bundled colab_job driver: one manifest allocates a session, installs packages, uploads inputs, runs the script detached, polls, downloads outputs, stops the session and writes a receipt. Use when a task needs a GPU, more RAM or CPU than the local machine, an isolated Python sandbox, or an offloaded batch job (backtests, parameter sweeps, fine-tuning, OCR, embeddings). Do not use for interactive REPL/console/Drive-mount work from a headless worker."
---

# colab-operator

Adapted from the upstream `colab-operator` skill in
https://github.com/googlecolab/google-colab-cli (Apache-2.0; see `NOTICE`).
The upstream runbook is printed by `colab skill`. This skill replaces most of
it with a driver, because three dogfood rounds (2026-09-24) failed on the
orchestration steps, never on the workload.

## 0. Where the driver is

`skill_dir` is the folder holding this file. The driver is
`$skill_dir/scripts/colab_job.py` (standard library only, Python 3.9+).

- Claude Code (user): `~/.claude/skills/colab-operator`
- Codex (user): `~/.agents/skills/colab-operator`
- Antigravity app: `~/.gemini/config/skills/colab-operator`; Antigravity CLI:
  `~/.gemini/antigravity-cli/skills/colab-operator.md` with assets under
  `.aorch-assets/colab-operator/`
- Grok: `~/.grok/skills/colab-operator`

If unsure, search those locations for `colab_job.py` and use the first hit.
Every command below is `python "$skill_dir/scripts/colab_job.py" ...`
(`uv run python` works too). Quote paths on Windows.

## 1. Local environment (read first)

- `colab` on this Windows machine is a shim (`~/.local/bin/colab.cmd`,
  `~/.local/bin/colab` for Git Bash) into the CLI installed in WSL
  `Ubuntu-24.04`. It forwards the current directory and already passes
  `--auth=adc`. Never pass `--auth` yourself and never `pip install
  google-colab-cli` on Windows (upstream: Linux/macOS only).
- Credentials are ADC minted inside WSL for the Colab account. A 401/403 from
  `colab.pa.googleapis.com` is a scope problem: report blocked with
  `colab whoami` output. `colab auth` is VM-side GCP auth, not CLI auth.
- Entitlement measured 2026-09-24: CPU and `--gpu T4` allocate; A100 is
  rejected. Put candidates in the manifest in preference order and let the
  driver fall back.
- Interactive commands (`repl`, `console`, `auth`, `drivemount`) expect a TTY
  and hang a headless worker. The driver never calls them.

## 2. Run a job

1. Write `job.json` next to the script and inputs (`template` prints one):

   ```json
   {
     "name": "ocr-sample",
     "accelerators": ["T4", "cpu"],
     "packages": ["mineru[torch]>=4.0,<5"],
     "requirements": null,
     "wheels_dir": null,
     "uploads": [{ "local": "input/sample.pdf", "remote": "/content/sample.pdf" }],
     "script": "job.py",
     "args": [],
     "env": { "MINERU_LANG": "korean" },
     "timeout_minutes": 30,
     "poll_seconds": 20,
     "outputs": [{ "remote": "/content/out", "local": "out" }],
     "keep_on_failure": false,
     "session_prefix": "aorch"
   }
   ```

   - `accelerators`: `T4 | L4 | G4 | H100 | A100 | v5e1 | v6e1 | cpu`, tried
     in order; every rejection is recorded and the run is `blocked` only when
     all are rejected. `cpu` is used only when listed.
   - `wheels_dir`: a local folder of `*.whl` uploaded and installed offline
     before `packages`/`requirements` (worth it for small pure-Python
     packages; torch-sized wheels upload slower than they install).
   - Local paths are relative to the manifest's folder. Remote paths are
     absolute under `/content`. The script runs on the VM as
     `python3 script.py args...` with `cwd=/content` and `env` exported; it
     must write results under an `outputs.remote` path and exit non-zero on
     failure.
2. `run job.json --max-wait 480`. Progress goes to stderr, the receipt JSON to
   stdout, and both are saved under `.colab-job/<name>/` next to the manifest
   (`state.json`, `job-receipt.json`, `job.log`).
3. Exit codes: `0` ok · `1` failed/blocked/aborted · `2` still running, call
   again · `3` finished but `colab stop` failed (run `colab stop -s <session>`
   by hand). The driver is resumable: a second `run` continues from the saved
   phase and never re-allocates or re-uploads.

Headless workers must not wait on background tasks or call `sleep`; the
driver does the waiting inside one foreground command bounded by
`--max-wait`. The loop that fits a shell tool with a time limit:

```bash
code=2; while [ "$code" -eq 2 ]; do
  python "$skill_dir/scripts/colab_job.py" run job.json --max-wait 480; code=$?
done
python "$skill_dir/scripts/colab_job.py" verify .colab-job/<name>/job-receipt.json
```

Other commands: `wait job.json` (poll only), `collect job.json` (one poll,
then download and stop), `abort job.json` (stop the session now),
`run job.json --dry-run` (print the plan, call nothing).

## 3. Receipt (`.colab-job/<name>/job-receipt.json`)

`status` (ok · failed · running · blocked · aborted), `session`,
`accelerator_requested`, `accelerator_used`, `attempts[]` (each candidate
with the backend's message), `timings{new,install,upload,launch,run,download,stop}`
in seconds (`run` is the script's own wall clock from the VM), `exit_code`,
`log_tail`, `gpu` (last `nvidia-smi` line), `outputs[{local,bytes}]`,
`commands[]` (every colab argv with exit code and seconds), `unresolved[]`,
`error`. `verify` exits 0 only when status is ok, every output exists and is
non-empty, `unresolved` is empty, and `colab sessions` no longer lists the
job's session.

## 4. Contract for aorch workers

- Put the driver commands you ran, with exit codes, in the receipt
  `commands`; attach the `verify` output as evidence.
- `filesChanged` lists the downloaded outputs and any report you wrote, and
  nothing on the VM. `.colab-job/` is state, not a deliverable; keep it in
  `.gitignore` or list it, never half.
- If `run` returns `blocked` (all accelerators rejected, auth), return
  `blocked` with the receipt's `error`; do not retry with tiers the task did
  not allow.
- A `partial` or `blocked` receipt still ends with no session left: the
  driver stops on failure unless `keep_on_failure` is set, and `verify`
  checks it. A session left running is the most expensive failure here.

## 5. Manual operation (only what the driver cannot do)

- Inspect a VM whose kernel is busy: `echo "<shell>" | colab console -s NAME`
  (tmux, filter output with `grep -a`). Do not `pkill -f <pattern>` when the
  pattern appears in your own command line; it kills the console shell first.
- `colab sessions`, `colab status -s NAME`, `colab log -s NAME -n 20`,
  `colab usage`, `colab stop -s NAME` are safe read/stop commands.
- Isolate concurrent runs with the global `--config <path>` if you ever
  bypass the driver; the driver names sessions `<prefix>-<name>-<hex>` so
  parallel jobs do not collide.
- GPU utilization 0 % with high CPU means the workload fell back to CPU;
  check the library's engine/device selection (MinerU: `--tier basic` runs
  torch on the GPU, `--tier standard` runs its VLM on CPU in the default
  wheel).

## 6. Recovery

- "Session not found" / 404 on exec: the backend pruned the VM. Run
  `abort` to clear the state, delete `.colab-job/<name>/`, and `run` again.
- `keep_alive_stopped reason=consecutive_4xx_errors` in `colab log`: missing
  `colaboratory` scope; report blocked.
- The CLI wheel pins the upstream `jupyter-kernel-client` fork; after
  `uv tool upgrade google-colab-cli` reinstall it with
  `uv tool install --force google-colab-cli --with "jupyter-kernel-client @ git+https://github.com/googlecolab/jupyter-kernel-client.git"`
  if `colab exec` raises `JupyterSubprotocol`.
