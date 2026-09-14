# Codex capability portability

The canonical user definitions enable `ship` and `invest-judge` on Claude Code
and Codex. Both use the host's question and evidence tools. Ship retains commit
and push permission gates and checks project `ship_triggers` in canonical
definitions as well as legacy Claude frontmatter. Investment review retains its
evidence, independence, and ledger requirements; a documented local vault may
provide evidence when the host has no vault MCP.

Project roles that prohibit shell execution can declare an OpenAI binding with
`sandbox_mode: "read-only"` and `features: { "shell_tool": false }`. These must
be project-scoped definitions and executed using their canonical `agentId`
through aorch with `allowedProviders: ["openai"]`.

The dispatcher starts `codex exec --ignore-user-config --skip-git-repo-check`
in a fresh temporary directory outside the project using the existing Codex
login. Project-local config and user MCP configuration are not loaded; managed
system policies still apply. The actual project remains the file MCP root and
the role must read its AGENTS.md before analysis. It disables shell execution,
both multi-agent implementations, hooks,
plugins, apps, and browser/computer tools, and injects only a scoped read-only
file MCP. It does not copy credentials. The tool router remains enabled so MCP
calls work; JavaScript computation is not an OS shell. Role instructions still
prohibit unsupported numerical claims and require parent-provided verified
calculation or retrieval evidence.

The file tools provide bounded text reads, directory listing, and plain-string
search. They reject escaping paths and sensitive filenames, and check realpath
containment. They are not an isolation boundary against another process running
as the same OS user changing files concurrently.

Native Codex child-agent configuration cannot remove inherited MCP servers.
Accordingly, generated presets for these restricted roles contain a routing
guard rather than the role body: direct child invocation returns blocked and
directs the lead to aorch. The guard is routing guidance, not an OS security
boundary. The isolated dispatcher loads the canonical role body.

Local verification on 2026-09-15 used Codex 0.153.4 with the existing login.
An actual `aorch_files.read_file` call returned a freshly generated nonce, with
no command-execution events and no available shell tools. Regression tests cover
native skill selection, routing guards, forwarded restrictions, scoped file
access, MCP protocol handling, and rejected escaping/sensitive paths.

QuantPilot's Codex skill contracts expose staged role execution. Its existing
Python designer/strategist jobs still call Claude; enabling the Codex roles does
not silently change those backend job runners.
