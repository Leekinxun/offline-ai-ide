# Subagents

The main agent can delegate a bounded task with `task({ agent_type, prompt })`. It chooses the role from the task and receives the child's summary before continuing. This does not require a fixed four-stage workflow or replace persistent teammates.

| Role | Responsibility | Tools |
| --- | --- | --- |
| `general` | Implement and verify an assigned task | All tools available to the parent, within inherited permissions and the child profile |
| `explore` | Read-only repository reconnaissance with file and line evidence | `read_file`, `find_files`, `search_files`, `list_directory` |
| `review` | Check correctness and regressions; return actionable findings | The four repository read tools and restricted `bash` inspection commands |
| `planner` | Investigate and return affected files, ordered steps, risks, and verification criteria | The four repository read tools and restricted `bash` inspection commands |

`agent_type` defaults to `explore`. Legacy `Explore` and `general-purpose` names remain accepted; the former internal `Code` name also maps to `general`. Unknown types fail before allocating a worktree or contacting a model.

Each child starts with a role-specific system prompt and the assigned task. Parent conversation history, memory, and loaded skills are not copied. Provide necessary context in `prompt`. Each child retains the existing managed worktree, run history, mutation evidence, and ChangeSet lifecycle. General file operations and commands run in the child's worktree; shared task and teammate coordinators remain available through their existing adapters. Changes still require the existing ChangeSet review and integration flow.

The runtime rejects tools absent from the child's advertised tool list, including forged write, shell, delegation, and MCP calls. `explore` cannot execute commands. `review` and `planner` cannot write files, call MCP, spawn children, or trigger the main agent's plan-approval flow. Their command policy permits only repository inspection commands and safe arguments, with an empty filesystem write grant. Tests and builds that require writes belong to `general`.

`general` uses the shared tool dispatcher rather than a separate four-tool implementation. The parent passes its actual tool schemas and authorization ceiling, including available MCP tools. Authorized lazy MCP activation refreshes the child's tool list. Only `general` can delegate again; synchronous nesting is limited to four levels. Existing step, tool, duration, token, and cost budgets continue to apply.

The existing settings profiles configure the roles: `subagent` for `general`, `explore` for `explore`, `review` for `review`, and `plan` for `planner`. The last two profiles also configure the corresponding main-agent modes. Overrides may narrow a role's tools but cannot add tools outside its role or parent permissions.

Repository inspection tools accept workspace-relative paths:

```json
{"agent_type":"explore","prompt":"Locate the authentication flow and report the key files and line numbers."}
{"agent_type":"review","prompt":"Review the authentication change for correctness and regressions. Return findings with evidence."}
{"agent_type":"planner","prompt":"Investigate adding refresh tokens and return an implementation plan with affected files and checks."}
{"agent_type":"general","prompt":"Implement the assigned refresh-token change and verify it."}
```

`find_files` accepts a glob `pattern` such as `**/*.ts`; `search_files` accepts `query` and optional `regex`; `list_directory` lists one directory level. All three accept optional `path` (default `.`) and `max_results` (default 100, capped at 500). They apply the same protected-path, generated-content, secret, and symlink policy as `read_file` and bound their output.
