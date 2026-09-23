# Python REPL for Pi

The `python` tool keeps a Python namespace alive for iterative calculations,
data exploration and plots. It starts on the first `exec`, using the dedicated
uv project at `~/Tools/pyenvs/pi-python-repl/`.

## Setup

This extension requires Pi's extension API, a POSIX host, uv, Python >=3.12, and
Matplotlib (which supplies Pillow for PNG validation). The project and its
`.venv` live under `~/Tools/pyenvs/`; no system Python packages are installed.
Runtime source stays beside this README so chezmoi manages it with the extension.

If the dedicated environment does not exist, run these Nushell commands:

```nu
uv init --bare --no-workspace --vcs none --python 3.12 ~/Tools/pyenvs/pi-python-repl
uv add --project ~/Tools/pyenvs/pi-python-repl matplotlib
uv sync --project ~/Tools/pyenvs/pi-python-repl
```

If chezmoi has already restored `pyproject.toml` and `uv.lock`, run only:

```nu
uv sync --project ~/Tools/pyenvs/pi-python-repl --locked
```

Load the installed extension with `/reload` in Pi. Loading Pi and calling
`status` do not start Python. Execution runs `uv --no-config run --project ...
--offline --no-sync python -I -u ...`; it never installs dependencies implicitly.
The worker verifies that `sys.prefix` is the dedicated project's `.venv`.

## Use

Ask Pi to use the `python` tool, or supply its tool arguments:

```json
{"action":"exec","command":"values = [1, 2, 3]\nsum(values)"}
```

The next call can reuse `values`:

```json
{"action":"exec","command":"sum(values) / len(values)","timeout":30}
```

`exec` returns stdout, stderr, the last expression, and images. `_` holds the
last non-None expression value. Ordinary exceptions are reported as tool errors;
assignments that happened before the exception remain in memory. Syntax errors
are checked before any part of that cell executes.

```json
{"action":"exec","command":"import matplotlib.pyplot as plt\nplt.plot(values)"}
```

Open Matplotlib figures are attached as PNGs and closed after each execution.
`display_png(path_or_bytes)` also attaches PNGs explicitly. Paths are relative
to the kernel's working directory. It initially uses Pi's cwd; `os.chdir()`
persists until reset. Use `plt.show()` only with a noninteractive backend; the
extension starts with `MPLBACKEND=Agg`.

```json
{"action":"status"}
```

Status returns the interpreter, project, PID, cwd, memory generation, at most
100 variable names/types, and the last 20 execution outcomes. It uses cached
metadata and does not call user `repr` methods or start the interpreter.

```json
{"action":"reset"}
```

Reset kills the process group and discards variables. The next execution starts
fresh. Files and external effects are not rolled back.

## Memory and limits

- Globals survive ordinary calls, model changes and context compaction. After
  compaction, inspect `status` before relying on variables mentioned in history.
- `/tree`, `/new`, `/resume`, `/fork`, `/clone`, `/reload`, and session shutdown
  discard the kernel. Restored chat history does not restore Python memory.
  No source is automatically replayed.
- Execution is sequential. The deadline defaults to 30 seconds, includes startup,
  and may be set from 1 to 600 seconds. Cancellation and timeout kill the process
  group and clear memory before reporting the failure.
- Input is limited to 100,000 UTF-8 bytes. stdout/stderr each retain their first
  24 KiB; tool text is further limited below 50 KiB and 2,000 lines. Excess is
  discarded, with a truncation notice. Save large results explicitly if needed.
- At most four PNGs are returned per execution, each no larger than 1 MiB and
  4096 pixels per side. Reduce plot size or save larger images explicitly.
- `input()` receives EOF. Notebook magics and top-level await are not supported.
  Do not launch background threads or processes: output and namespace snapshots
  are meaningful only for work completed within a call. No memory quota is
  imposed on user code; output limits are not a limit on Python allocations.
- Extract reproducible work into scripts once exploration is complete.

## Permissions and delegation

`security-rules.toml` routes `python` / `exec` through the existing confirmation
and audit mechanism. The `command` field contains the Python source displayed
for approval. `status` and `reset` need no execution approval. Noninteractive
execution without an approval UI is blocked by the security gate.

Python has the user's local permissions. The uv environment isolates packages,
not filesystem or network access. Existing protected-path and authorization
instructions still apply. Arbitrary Python and retained objects cannot be
reliably analyzed using the gate's shell/path matchers; approval must consider
the submitted code and existing kernel state. Do not bypass a denied action.
The existing gate's missing/malformed-rule behavior is unchanged.

The parent delegation guard treats `python` like arbitrary execution. Delegated
agents cannot execute it in this version, even if added to their tool allowlist:
their workspace restrictions do not provide a Python sandbox. Separate normal
Pi processes have separate kernels. No model/provider preference is embedded.

## Verify and troubleshoot

Run the installed tests without network calls:

```nu
node --test ~/.pi/agent/extensions/python-repl/test/runtime.test.mjs ~/.pi/agent/extensions/python-repl/test/extension.test.mjs
```

Tests exercise the actual uv worker and Pi extension loader, plus fake deadlines
and filesystem handshakes for cancellation. Security tests use a temporary agent
configuration and never alter the live audit log.

For a missing-environment error, run `uv sync` in the dedicated project. After
changing dependencies, reset the kernel. For unknown variables after a session
change, inspect `status` and explicitly load the needed data again. A crash or
protocol failure clears memory and is reported; the next execution starts fresh.
