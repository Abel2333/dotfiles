# 沙箱与命令拦截调研笔记

> 调研时间：2026-08-28。对象：Codex CLI 0.149.0（本机安装）、openai/codex 仓库源码、
> 10knamesmore/dotfiles 的 cc-hooks、pi 的 sandbox 示例扩展、npm `@anthropic-ai/sandbox-runtime` 0.0.74。
> 用途：为 pi 安全扩展的「执行层沙箱」选型存档。

## 1. 两个正交的防护层

| 层 | 回答的问题 | 机制 | 本仓库现状 |
|---|---|---|---|
| 拦截层（interception） | 这个命令该不该执行？ | 规则引擎在 `tool_call` 事件里匹配，deny/ask/log | 已实现（TOML 规则引擎） |
| 执行层（enforcement） | 放出去了，它能造成多大破坏？ | OS 内核强制限制文件系统/网络/syscall 视图 | 未实现（本调研的对象） |

Codex 的架构验证了这两层叠加是生产可行的：approval 策略决定「要不要沙箱、要不要问用户」，
sandbox 保证「就算放行，也破坏不了沙箱外的东西」。

## 2. Codex 的沙箱实现

### 2.1 平台抽象

`SandboxManager.transform()` 把一个可移植的 `CommandSpec`（程序 + 参数 + cwd + env）
变换成带沙箱包装的 `ExecRequest`，按平台分派：

- `MacosSeatbelt` — macOS 12+
- `LinuxSeccomp` — bubblewrap + seccomp（当前默认；Landlock 为 legacy fallback）
- `WindowsRestrictedToken` — 受限 token + job object，进程内执行
- `None` — 不沙箱

策略输入是结构化的 `FileSystemSandboxPolicy`（可读根、可写根、可写根内的只读 carve-out、
unreadable globs）和 `NetworkSandboxPolicy`（enabled / restricted / 代理模式）。

### 2.2 macOS：Apple Seatbelt

- 调**固定路径** `/usr/bin/sandbox-exec`（不走 PATH，注释明说是防注入：能篡改
  /usr/bin/sandbox-exec 的攻击者已经有 root 了）
- 动态生成 Scheme profile：`(deny default)` 起步，然后按需放行：
  - 文件读：`file-read*` 按 `READABLE_ROOT_N` 参数化
  - 文件写：只给 writable roots，`(allow file-write* (subpath (param "WRITABLE_ROOT_0")))`
  - 网络：默认无规则（即拒绝）；代理模式只放行 loopback 到代理端口 + DNS(53) + 指定 unix socket
  - `/dev/null` 可写、sysctl 白名单、允许 fork/exec（子进程继承策略）
- 路径一律用 `-DKEY=path` 参数注入，不拼进 profile 文本（防 profile 语法注入）
- 精妙细节 **protected ancestors**：对可写根内的只读子路径，逐级禁止其父目录的
  `file-write-unlink`，防止用 `rename(2)` 把只读子树整体挪出策略覆盖范围
- fail-closed 示例：代理模式启用了但推断不出可用 loopback 端点时，网络策略直接返回空
  （全断），注释写明「避免悄悄放大网络权限」

### 2.3 Linux：bubblewrap 两段式（重点）

独立 helper 二进制 `codex-linux-sandbox`（随 npm 包分发；本机位于
`~/.local/share/mise/installs/codex/<ver>/codex-resources/`，内含捆绑的 bwrap）。
执行序列：

1. **外层——bubblewrap 建视图**
   - `--unshare-user --unshare-pid`：user + PID 命名空间隔离
   - 绑定挂载构造文件系统：系统目录只读 ro-bind，writable roots 可写，挂全新 `/proc`
     （受限容器环境可 `--no-proc` 降级）
   - 断网用 `--unshare-net`：整个网络 namespace 消失，比拦 syscall 更彻底
   - bwrap 二进制优先取系统 PATH 上的（跳过 cwd 里的，防投毒）；PATH 上没有或太老
     （不支持 `--argv0`）则用随包捆绑的 bwrap
2. **内层——re-exec 自身收紧 syscall**（`--apply-seccomp-then-exec`）
   - 在 bwrap 视图建好**之后**才 `PR_SET_NO_NEW_PRIVS` + seccomp——顺序是故意的：
     很多 bwrap 部署依赖 setuid，先 no_new_privs 会把 bwrap 卡死
   - seccomp BPF（seccompiler crate）：默认 allow，命中规则返回 EPERM
     - 无条件禁：`ptrace`、`process_vm_readv/writev`、`io_uring_*`
     - 网络受限时禁：`connect/accept/accept4/bind/listen/sendto/...`；
       `socket()`/`socketpair()` 带条件规则只允许 `AF_UNIX`
     - 代理模式反过来：只允许 `AF_INET/AF_INET6`（流量强制走内部 TCP→UDS→TCP 桥
       到代理端点），`socketpair()` 只允许 AF_UNIX
   - seccomp 只贴在**当前线程**上，随后 exec 的子进程继承，主 CLI 进程不受影响
3. 最后 `execvp` 真正的用户命令

**Landlock**（早期方案，现 legacy）：`ruleset.restrict_self()` 直接贴当前线程，
全盘只读 + writable_roots 可写。不支持「受限可读」策略，且能力弱于 bwrap
（无命名空间隔离），只在策略能无损映射到旧模型时经 `use_legacy_landlock=true` 启用。

**WSL 支持**：WSL2 走正常 bubblewrap 路径；WSL1 无法创建 user namespace，不支持。

### 2.4 其他值得借鉴的设计

- 子进程通过环境变量知道自己在沙箱里（`CODEX_SANDBOX_*`），子 agent/工具可感知
- `is_likely_sandbox_denied()` 用启发式判断失败是否沙箱造成，用于触发「升级审批后
  非沙箱重试」的交互流
- 沙箱策略里有「managed network requirements」概念：企业策略要求网络必须受限时，
  即使 `DangerFullAccess` 也 fail-closed

## 3. cc-hooks 的拦截层设计（10knamesmore/dotfiles）

`cli/crates/cc-hooks` + `~/.claude/hooks/pretool.toml`，Claude Code 的 PreToolUse hook：

- 单个 Rust 二进制统一入口，子命令 = hook 生命周期事件；规则全部数据化在 TOML
- **fail-open 铁律**：配置缺失/stdin 坏了静默放行；规则解析失败放行 + stderr 留痕
  （守卫静默失效必须可见）
- 业务函数纯化（不做 IO，返回 `HookRun`），由 wire 层统一落地退出码/审计
- argv 级规则引擎：短旗标簇展开、引号/heredoc/`--` 感知、`path_outside` 白名单豁免、
  `where` 字段匹配器（equals/contains/prefix/suffix/glob/domain/re + not 嵌套）
- **deny 的 reason 喂回模型**做工具偏好重定向（grep→rg、pip→uv 等）；ask 弹窗问用户

我们的 pi 规则引擎已吸收这套设计（见 `~/.pi/agent/security-rules.toml` 头部注释）。

## 4. pi 执行层沙箱的选项对比

| 方案 | 依赖 | 评价 |
|---|---|---|
| **A. 直接用系统 bwrap** | 无 npm 依赖（本机 `/usr/bin/bwrap` 已装） | 推荐。`tool_call` input mutation 把命令包一层 bwrap；策略完全自控，与规则引擎风格统一 |
| B. `@anthropic-ai/sandbox-runtime` | npm 包 + node_modules | pi 官方 sandbox 示例用的它，配置 JSON 驱动、跨平台开箱即用；node_modules 与 chezmoi 同步冲突，策略表达力未必强于自构 bwrap 参数 |
| C. 复用 `codex sandbox` CLI | 本机已装 codex | 能跑但策略要走 codex 的配置体系（~/.codex/config.toml），耦合另一个工具的安装与版本 |
| D. 直接用 Landlock | 需自写原生 helper | Node 无现成绑定，Codex 自己都已将其降级，不值得 |

关键认知：**Anthropic 的包和 Codex 底层是同一套原语**（Linux=bubblewrap，macOS=Seatbelt），
npm 包只是封装。WSL2 走正常 bubblewrap 路径（Codex 文档明确；WSL1 不支持）。

## 5. 若实施方案 A 的注意点

1. **接线顺序**：`tool_call` 的 input mutation 对后续 handler 可见。bwrap 包装必须在
   规则引擎评估**之后**执行（否则引擎匹配到的是包装后的 argv），或在独立的
   工具覆盖层做。
2. **策略来源**：可写根默认 = 会话 cwd + `/tmp`；只读 = 全盘。`~/.ssh`、`~/.gnupg`
   等可从 bwrap 视图里直接不挂载（比规则拦截更硬）。
3. **网络**：默认 `--unshare-net` 最安全，但会破坏大量正常工作流（git、包管理）。
   折中：默认联网，规则引擎里对网络命令单独 ask；或按项目配置。
4. **与 ask 决策的交互**：ask 放行的危险命令应该**脱离沙箱**重跑还是沙箱内跑？
   Codex 的做法是升级审批后非沙箱重试。我们可以简化为：沙箱只负责默认收口，
   ask 通过的不额外处理。
5. **失败识别**：参考 Codex 的 `is_likely_sandbox_denied`，沙箱导致的失败（EPERM、
   只读文件系统错误）应给模型清晰的提示而不是原始报错。

## 6. 参考

- Codex 源码：`codex-rs/sandboxing/src/seatbelt.rs`、`codex-rs/linux-sandbox/src/{linux_run_main,landlock}.rs`、`codex-rs/core/src/sandboxing/mod.rs`
- Codex 文档：`docs/sandbox.md`（`codex sandbox linux|macos [--full-auto] COMMAND` 可手动体验）
- cc-hooks：`github.com/10knamesmore/dotfiles` 的 `cli/crates/cc-hooks/` 与 `tree/home/.claude/hooks/pretool.toml`
- pi 沙箱示例：`pi-coding-agent/examples/extensions/sandbox/`（@anthropic-ai/sandbox-runtime + bubblewrap）
- bubblewrap：`github.com/containers/bubblewrap`
