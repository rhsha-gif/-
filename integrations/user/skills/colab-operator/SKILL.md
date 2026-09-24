---
name: colab-operator
description: "Operate Google Colab runtimes through the `colab` CLI: provision CPU/GPU/TPU sessions, run Python scripts or notebooks on the remote VM, sync files, install packages and export session history. Use when a task needs a GPU, more RAM or CPU than the local machine, an isolated Python sandbox, or an offloaded batch job (backtests, parameter sweeps, fine-tuning, PDF/embedding pipelines). Do not use for interactive REPL/console/Drive-mount work from a headless worker."
---

# colab-operator

Adapted from the upstream `colab-operator` skill in
https://github.com/googlecolab/google-colab-cli (Apache-2.0); see `NOTICE`.
The upstream text is also printed by `colab skill`. This file adds the local
environment contract that the upstream skill does not know about.

## Local environment (read first)

- `colab` on this Windows machine is a shim (`~/.local/bin/colab`, `colab.cmd`)
  that forwards to the CLI installed in WSL `Ubuntu-24.04`, with the current
  directory forwarded and `--auth=adc` already applied. Call it as a normal
  command from Bash, PowerShell or cmd; never pass `--auth` again and never
  try `pip install google-colab-cli` on Windows (upstream: Linux/macOS only).
- Paths: relative paths are resolved from your current directory. An absolute
  local path must be in WSL form (`/mnt/c/Users/...`), not `C:\...`. Remote
  paths live under `/content`.
- Credentials are ADC minted by `gcloud auth application-default login` inside
  WSL for the account that owns the Colab Pro subscription. A 401/403 from
  `colab.pa.googleapis.com` means a scope problem; report it as blocked with
  `colab whoami` output. Do not run `colab auth`, which is VM-side GCP auth.
- Entitlement measured 2026-09-24: CPU and `--gpu T4` allocate; `--gpu A100`
  is rejected. Check `colab usage` before requesting L4/A100/H100/TPU and fall
  back to T4 or CPU when the backend rejects an accelerator (HTTP 400).
- Interactive commands (`repl`, `console`, `auth`, `drivemount`) expect a TTY
  and hang in a headless worker. Do not call them; use `exec`, `run` or piped
  stdin (`echo "print(1)" | colab exec -s NAME`).

## Mental model

- A session is a live Jupyter kernel on a rented, billable VM. `colab new`
  allocates it, `colab stop` releases it; nothing else reclaims it before the
  24-hour cap. An unstopped session keeps burning compute units.
- Kernel state persists across `colab exec` calls in the same session
  (imports, variables, files under `/content`). Build state incrementally.
- Default working directory on the VM is `/content`; prefer absolute
  `/content/...` paths for uploads, downloads and outputs.
- Each command authenticates, does one thing and exits. A background daemon
  started by `colab new` keeps the VM alive; you do not manage it.

## Commands

| Need | Command |
|---|---|
| One-shot job (new + exec + stop) | `colab run [--gpu T4] [--keep] script.py [args...]` |
| Named session | `colab new -s NAME [--gpu T4 \| --tpu v6e1] [--high-mem]` |
| Run local script on the VM | `colab exec -s NAME -f script.py` |
| Run notebook | `colab exec -s NAME -f nb.ipynb` (writes `nb_output.ipynb`) |
| Packages | `colab install -s NAME pkg ...` or `-r requirements.txt` |
| Files | `colab upload -s NAME LOCAL /content/x`, `colab download -s NAME /content/x LOCAL`, `colab ls -s NAME /content` |
| Inspect | `colab sessions`, `colab status -s NAME`, `colab log -s NAME -n 20`, `colab usage` |
| Export history | `colab log -s NAME -o run.ipynb` (also `.md`, `.txt`, `.jsonl`) |
| Reset | `colab restart-kernel -s NAME`; `colab stop -s NAME` |

- `colab run` writes its own `[colab] ...` chatter to stderr and the script's
  stdout to stdout, propagates the script's exit code, and stops the VM even
  when the script fails (unless `--keep`). A missing script path fails before
  any VM is allocated.
- Always pass `-s NAME`. Use `aorch-<taskId>` so the lead can match sessions
  to receipts. An unrecognized `--gpu` value silently falls back to A100.

## Offload recipe (backtest, sweep, batch pipeline)

1. `colab new -s aorch-<taskId> [--gpu T4]`
2. `colab install -s aorch-<taskId> -r requirements.txt` (or explicit packages)
3. `colab upload -s aorch-<taskId> data.parquet /content/data.parquet`
4. `colab exec -s aorch-<taskId> -f job.py` — the script must write results to
   `/content/out/...` and exit non-zero on failure.
5. `colab download -s aorch-<taskId> /content/out/result.json ./result.json`
6. `colab stop -s aorch-<taskId>` and confirm with `colab sessions`.

For a self-contained script with no input files, replace steps 1 to 6 with a
single `colab run`.

## Long-running jobs (measured 2026-09-24)

- `colab exec` streams one kernel cell and blocks until it finishes. A worker's
  shell tool has its own time limit (Claude Code: 10 minutes); when that limit
  kills the local command the kernel keeps running the cell, the stream is
  lost, and every later `colab exec` queues behind the busy kernel. Never wait
  on a job that can take more than a few minutes inside one `colab exec`.
- Pattern: launch detached, then poll. Through `colab exec`, run Python that
  calls `subprocess.run("cd /content && nohup sh -c '<job>; echo EXIT=$? >> /content/job.log' > /content/job.log 2>&1 &", shell=True)`,
  then every 30 to 60 seconds run a short `colab exec` that prints
  `tail -c 600 /content/job.log` and `nvidia-smi --query-gpu=memory.used,utilization.gpu --format=csv,noheader`.
  Write timestamps (`date +%s`) before and after the job so wall-clock time is
  in the log, not in your shell.
- Headless workers cannot wait: starting a background task and waiting for
  its notification, or calling `sleep`, ends the run with a partial receipt
  (measured 2026-09-24). Poll with one foreground bash loop whose iterations
  are `colab exec` calls; each call takes a few seconds and is the throttle.
  Cap the loop (for example 60 iterations) and report blocked with the log
  tail when it runs out.
- Inspecting a VM whose kernel is busy: `echo "<shell>" | colab console -s NAME`
  runs in a tmux shell independent of the kernel (filter output with
  `grep -a`). Do not `pkill -f <pattern>` from there when `<pattern>` appears
  in your own command line; it kills the console shell first.
- GPU utilization of 0 % with high CPU means the job fell back to CPU. Check
  the engine or device selection before assuming the GPU is slow.

## Known workload: MinerU OCR on a T4

- `colab install -s NAME "mineru[torch]>=4.0,<5"` then
  `mineru-kit models download --tier basic` (models arrive in seconds from
  Hugging Face on the VM).
- `--tier basic` runs the torch pipeline (layout, OCR, formula, table) on the
  GPU: 2 pages in 15 seconds including model load. `--tier standard` adds the
  MinerU2.5 VLM through llama-cpp, which runs on the CPU in the default wheel
  and did not finish 11 pages in 13 minutes; use it only with the `[full]`
  extra and `--vlm-engine vllm`, which was not tested.
- `MINERU_LANG=korean` selects the Korean OCR dictionary. Outputs:
  `-f markdown -o /content/out/x.md` and `-f middle_json -o /content/out/x.json`.
- Known defect: Korean particles glued to a formula (에, 이, 을) are absorbed
  into the LaTeX as garbage tokens; the Markdown needs a correction pass.

## Parallel or isolated runs

Point session state at a scratch file so concurrent workers do not share
`~/.config/colab-cli/sessions.json`: `colab --config /tmp/aorch-<taskId>.json new -s ...`.
Every later command for that session must repeat the same `--config`.

## Receipt contract for aorch workers

- Record every `colab` command with its exit code in `commands`.
- Before returning, run `colab sessions` and include the output as evidence
  that no session you created is still allocated. A leaked session is an
  unresolved risk, not a success.
- Downloaded files are the only changes to list in `filesChanged`; nothing on
  the VM counts.
- If the accelerator is rejected or auth fails, return `blocked` with the
  exact `[colab]` message rather than retrying with a different tier unless
  the task allowed the fallback.
- A `partial` or `blocked` receipt still ends with `colab stop -s NAME`
  unless the task said to keep the session; a session left running after the
  worker exits is the most expensive failure this skill can produce.

## Recovery

- "Session not found" / 404 on exec: the backend pruned the VM. Run
  `colab sessions`, then `colab new` again and redo the setup steps.
- Wedged kernel or timeout: `colab restart-kernel -s NAME` keeps the VM;
  otherwise `stop` and `new`.
- `colab log` showing `keep_alive_stopped reason=consecutive_4xx_errors` is
  a missing `colaboratory` scope; report as blocked.
