# Native prompt implementation for Nushell.
#
# Loaded via `use` from env.nu.  All helper functions stay scoped to the
# module; only `$env.PROMPT_*` and related config are exported.

const PROMPT_HOST_INFO = (sys host)
const PROMPT_DIR_TRUNCATION_LENGTH = 3
const PROMPT_DIR_TRUNCATION_SYMBOL = "…/"

def prompt-style [style: string, text: string] {
    if ($text | is-empty) {
        ""
    } else {
        $"(ansi $style)($text)(ansi reset)"
    }
}

def prompt-join [parts: list<string>, separator: string = ""] {
    $parts
    | where {|part| not ($part | is-empty)}
    | str join $separator
}

def prompt-prefix [symbol: string] {
    prompt-style "green_bold" $symbol
}

def prompt-os-id [] {
    let os_name = ($PROMPT_HOST_INFO.name | str downcase)

    if ($os_name | str contains "arch") {
        "arch"
    } else if ($os_name | str contains "debian") {
        "debian"
    } else if ($os_name | str contains "fedora") {
        "fedora"
    } else if ($os_name | str contains "gentoo") {
        "gentoo"
    } else if ($os_name | str contains "ubuntu") {
        "ubuntu"
    } else if $nu.os-info.name == "windows" {
        "windows"
    } else {
        try {
            open --raw /etc/os-release
            | lines
            | parse 'ID="{id}"'
            | get id.0?
            | str downcase
        } catch {
            ""
        }
    }
}

def prompt-os-symbol [] {
    match (prompt-os-id) {
        "arch" => "󰣇 ",
        "debian" => " ",
        "fedora" => " ",
        "gentoo" => " ",
        "ubuntu" => " ",
        "windows" => " ",
        _ => " ",
    }
}

def prompt-home-relative [cwd: string] {
    let cwd = ($cwd | into string)
    let home = ($nu.home-dir | into string)

    if $cwd == $home {
        "~"
    } else if ($cwd | str starts-with $home) {
        let rel = ($cwd | path relative-to $home)
        if $rel == "." {
            "~"
        } else {
            $"~/($rel)"
        }
    } else {
        $cwd
    }
}

def prompt-truncate-path [path_text: string] {
    if $path_text == "/" or $path_text == "~" {
        return $path_text
    }

    let segments = (
        $path_text
        | split row "/"
        | where {|segment| $segment != ""}
    )

    if ($segments | length) <= $PROMPT_DIR_TRUNCATION_LENGTH {
        return $path_text
    }

    let tail = ($segments | last $PROMPT_DIR_TRUNCATION_LENGTH | str join "/")

    if ($path_text | str starts-with "~/") {
        $"~/($PROMPT_DIR_TRUNCATION_SYMBOL)($tail)"
    } else if ($path_text | str starts-with "/") {
        $"/($PROMPT_DIR_TRUNCATION_SYMBOL)($tail)"
    } else {
        $"($PROMPT_DIR_TRUNCATION_SYMBOL)($tail)"
    }
}

def prompt-read-text-file [file: string] {
    if not ($file | path exists) {
        return ""
    }

    try {
        open --raw $file
        | decode utf-8
        | str trim
    } catch {
        ""
    }
}

def prompt-git-rev-info [] {
    if (which git | is-empty) {
        return {
            inside_repo: false
            root: ""
            root_name: ""
            prefix: ""
            git_dir: ""
        }
    }

    let result = (do { ^git rev-parse --show-toplevel --show-prefix --absolute-git-dir } | complete)
    if $result.exit_code != 0 {
        return {
            inside_repo: false
            root: ""
            root_name: ""
            prefix: ""
            git_dir: ""
        }
    }

    let lines = (($result.stdout | split row "\n") ++ ["", "", ""])
    let root = (($lines | get 0) | str trim)
    let prefix = (($lines | get 1) | str trim)
    let git_dir = (($lines | get 2) | str trim)

    {
        inside_repo: true
        root: $root
        root_name: ($root | path basename)
        prefix: $prefix
        git_dir: $git_dir
    }
}

def prompt-git-state-info [git_dir: string] {
    let rebase_merge = ($git_dir | path join "rebase-merge")
    let rebase_apply = ($git_dir | path join "rebase-apply")

    if ($rebase_merge | path exists) {
        return {
            state: "REBASING"
            progress_current: (prompt-read-text-file ($rebase_merge | path join "msgnum"))
            progress_total: (prompt-read-text-file ($rebase_merge | path join "end"))
        }
    }

    if ($rebase_apply | path exists) {
        return {
            state: "REBASING"
            progress_current: (prompt-read-text-file ($rebase_apply | path join "next"))
            progress_total: (prompt-read-text-file ($rebase_apply | path join "last"))
        }
    }

    if (($git_dir | path join "MERGE_HEAD") | path exists) {
        return { state: "MERGING", progress_current: "", progress_total: "" }
    }

    if (($git_dir | path join "CHERRY_PICK_HEAD") | path exists) {
        return { state: "CHERRY-PICKING", progress_current: "", progress_total: "" }
    }

    if (($git_dir | path join "REVERT_HEAD") | path exists) {
        return { state: "REVERTING", progress_current: "", progress_total: "" }
    }

    if (($git_dir | path join "BISECT_LOG") | path exists) {
        return { state: "BISECTING", progress_current: "", progress_total: "" }
    }

    { state: "", progress_current: "", progress_total: "" }
}

def prompt-git-status-info [] {
    let result = (do { ^git status --branch --porcelain=2 } | complete)
    if $result.exit_code != 0 {
        return {
            branch: ""
            oid: ""
            ahead: 0
            behind: 0
            conflicted: 0
            untracked: 0
            modified: 0
            staged: 0
            renamed: 0
            deleted: 0
        }
    }

    $result.stdout
    | lines --skip-empty
    | reduce -f {
        branch: ""
        oid: ""
        ahead: 0
        behind: 0
        conflicted: 0
        untracked: 0
        modified: 0
        staged: 0
        renamed: 0
        deleted: 0
    } {|line, acc|
        if ($line | str starts-with "# branch.head ") {
            $acc | merge { branch: ($line | str replace "# branch.head " "") }
        } else if ($line | str starts-with "# branch.oid ") {
            $acc | merge { oid: ($line | str replace "# branch.oid " "") }
        } else if ($line | str starts-with "# branch.ab ") {
            let parsed = ($line | parse "# branch.ab +{ahead} -{behind}")
            if ($parsed | is-empty) {
                $acc
            } else {
                let counts = ($parsed | first)
                $acc | merge {
                    ahead: (try { $counts.ahead | into int } catch { 0 })
                    behind: (try { $counts.behind | into int } catch { 0 })
                }
            }
        } else if ($line | str starts-with "? ") {
            $acc | merge { untracked: ($acc.untracked + 1) }
        } else if ($line | str starts-with "u ") {
            $acc | merge { conflicted: ($acc.conflicted + 1) }
        } else if ($line | str starts-with "1 ") or ($line | str starts-with "2 ") {
            let xy = ($line | split row " " | get 1)
            let x = ($xy | str substring 0..0)
            let y = ($xy | str substring 1..1)
            let staged_inc = if $x != "." { 1 } else { 0 }
            let modified_inc = if $y != "." { 1 } else { 0 }
            let renamed_inc = if $x == "R" or $y == "R" { 1 } else { 0 }
            let deleted_inc = if $x == "D" or $y == "D" { 1 } else { 0 }
            let conflicted_inc = if ($xy | str contains "U") or $xy == "AA" or $xy == "DD" { 1 } else { 0 }

            $acc | merge {
                staged: ($acc.staged + $staged_inc)
                modified: ($acc.modified + $modified_inc)
                renamed: ($acc.renamed + $renamed_inc)
                deleted: ($acc.deleted + $deleted_inc)
                conflicted: ($acc.conflicted + $conflicted_inc)
            }
        } else {
            $acc
        }
    }
}

def prompt-git-stash-count [] {
    let result = (do { ^git rev-list --walk-reflogs --count refs/stash } | complete)
    if $result.exit_code != 0 {
        return 0
    }

    try {
        $result.stdout | str trim | into int
    } catch {
        0
    }
}

def prompt-git-context [] {
    let rev = (prompt-git-rev-info)
    if not $rev.inside_repo {
        return ($rev | merge {
            branch: ""
            branch_display: ""
            oid: ""
            ahead: 0
            behind: 0
            conflicted: 0
            untracked: 0
            modified: 0
            staged: 0
            renamed: 0
            deleted: 0
            stashed: 0
            state: ""
            progress_current: ""
            progress_total: ""
        })
    }

    let status = (prompt-git-status-info)
    let state = (prompt-git-state-info $rev.git_dir)
    let branch_display = if $status.branch == "(detached)" {
        let short_oid = if ($status.oid | str length) >= 7 {
            $status.oid | str substring 0..6
        } else {
            $status.oid
        }
        $"detached@($short_oid)"
    } else {
        $status.branch
    }

    $rev
    | merge $status
    | merge $state
    | merge {
        branch_display: $branch_display
        stashed: (prompt-git-stash-count)
    }
}

def prompt-repo-relative-path [git_ctx: record] {
    let suffix_segments = (
        $git_ctx.prefix
        | split row "/"
        | where {|segment| $segment != ""}
    )

    ([$git_ctx.root_name] ++ $suffix_segments) | str join "/"
}

def prompt-python-project [] {
    [
        "pyproject.toml"
        "requirements.txt"
        "setup.py"
        ".python-version"
    ] | any {|name| (($env.PWD | path join $name) | path exists)}
}

def prompt-rust-project [] {
    [
        "Cargo.toml"
        "rust-toolchain.toml"
        "rust-toolchain"
    ] | any {|name| (($env.PWD | path join $name) | path exists)}
}

def prompt-python-version [] {
    if (which python | is-empty) {
        ""
    } else {
        try {
            ^python --version
            | str trim
            | split row " "
            | get 1
        } catch {
            ""
        }
    }
}

def prompt-rust-version [] {
    if (which rustc | is-empty) {
        ""
    } else {
        try {
            ^rustc --version
            | str trim
            | split row " "
            | get 1
        } catch {
            ""
        }
    }
}

def prompt-format-duration [ms: int] {
    if $ms >= 3600000 {
        let hours = ($ms // 3600000)
        let minutes = (($ms mod 3600000) // 60000)
        if $minutes > 0 {
            $"($hours)h ($minutes)m"
        } else {
            $"($hours)h"
        }
    } else if $ms >= 60000 {
        let minutes = ($ms // 60000)
        let seconds = (($ms mod 60000) // 1000)
        if $seconds > 0 {
            $"($minutes)m ($seconds)s"
        } else {
            $"($minutes)m"
        }
    } else if $ms >= 1000 {
        let seconds = ($ms // 1000)
        let rem_ms = ($ms mod 1000)
        if $seconds < 10 and $rem_ms >= 100 {
            let tenths = ($rem_ms // 100)
            $"($seconds).($tenths)s"
        } else {
            $"($seconds)s"
        }
    } else {
        $"($ms)ms"
    }
}

def prompt-os [] {
    prompt-style "white" (prompt-os-symbol)
}

def prompt-username [] {
    let user = ($env | get --optional USER | default "")
    let ssh = (($env | get --optional SSH_CONNECTION | default "") != "")

    if $user == "root" or $ssh {
        prompt-style "yellow_bold" $"($user)"
    } else {
        ""
    }
}

def prompt-hostname [] {
    let ssh = (($env | get --optional SSH_CONNECTION | default "") != "")

    if $ssh {
        prompt-style "cyan_bold" $"@ ($PROMPT_HOST_INFO.hostname)"
    } else {
        ""
    }
}

def prompt-directory [git_ctx: record] {
    let display_path = if $git_ctx.inside_repo {
        prompt-truncate-path (prompt-repo-relative-path $git_ctx)
    } else {
        prompt-truncate-path (prompt-home-relative $env.PWD)
    }

    prompt-style "#89B4FA" $"($display_path) "
}

def prompt-git-count-symbol [count: int, symbol: string] {
    if $count <= 0 {
        ""
    } else if $count == 1 {
        $symbol
    } else {
        $"($symbol) ($count)"
    }
}

def prompt-git-presence-symbol [count: int, symbol: string] {
    if $count <= 0 {
        ""
    } else {
        $symbol
    }
}

def prompt-git-ahead-behind [git_ctx: record] {
    if $git_ctx.ahead > 0 and $git_ctx.behind > 0 {
        $"⇡($git_ctx.ahead)⇣($git_ctx.behind)"
    } else if $git_ctx.ahead > 0 {
        $"⇡($git_ctx.ahead)"
    } else if $git_ctx.behind > 0 {
        $"⇣($git_ctx.behind)"
    } else {
        ""
    }
}

def prompt-git-branch [git_ctx: record] {
    if not $git_ctx.inside_repo or ($git_ctx.branch_display | is-empty) {
        return ""
    }

    prompt-style "magenta_bold" $"on  ($git_ctx.branch_display) "
}

def prompt-git-state [git_ctx: record] {
    if not $git_ctx.inside_repo or ($git_ctx.state | is-empty) {
        return ""
    }

    let progress = if ($git_ctx.progress_current | is-empty) or ($git_ctx.progress_total | is-empty) {
        ""
    } else {
        $" ($git_ctx.progress_current)/($git_ctx.progress_total)"
    }

    prompt-style "yellow_bold" $"(($git_ctx.state)($progress)) "
}

def prompt-git-status [git_ctx: record] {
    if not $git_ctx.inside_repo {
        return ""
    }

    let status_body = (prompt-join [
        (prompt-git-presence-symbol $git_ctx.conflicted "✘")
        (prompt-git-presence-symbol $git_ctx.untracked "?")
        (prompt-git-presence-symbol $git_ctx.modified "!")
        (prompt-git-presence-symbol $git_ctx.staged "+")
        (prompt-git-presence-symbol $git_ctx.renamed "»")
        (prompt-git-presence-symbol $git_ctx.deleted "")
        (prompt-git-ahead-behind $git_ctx)
        (prompt-git-presence-symbol $git_ctx.stashed "󰋻")
    ] " ")

    if ($status_body | is-empty) {
        ""
    } else {
        prompt-style "cyan_bold" $"[ ($status_body) ]"
    }
}

def prompt-rust [] {
    if not (prompt-rust-project) {
        return ""
    }

    let version = (prompt-rust-version)
    let content = if ($version | is-empty) {
        "󱘗 "
    } else {
        $"󱘗 ($version) "
    }

    prompt-style "red_bold" $content
}

def prompt-python [] {
    let venv = ($env | get --optional VIRTUAL_ENV | default "")
    let has_context = ($venv != "") or (prompt-python-project)

    if not $has_context {
        return ""
    }

    let env_name = if $venv == "" { "" } else { $"(($venv | path basename)) " }
    let version = (prompt-python-version)
    let content = if ($version | is-empty) {
        $"󰌠 ($env_name)"
    } else {
        $"󰌠 ($env_name)($version) "
    }

    prompt-style "yellow_bold" $content
}

def prompt-conda [] {
    let conda_env = ($env | get --optional CONDA_DEFAULT_ENV | default "")

    if ($conda_env | is-empty) {
        ""
    } else {
        prompt-style "green_bold" $" ($conda_env) "
    }
}

def prompt-right-duration [] {
    let raw = ($env | get --optional CMD_DURATION_MS | default "")
    let ms = (try { $raw | into int } catch { 0 })

    if $ms < 1000 {
        ""
    } else {
        prompt-style "yellow" (prompt-format-duration $ms)
    }
}

def prompt-right-time [] {
    prompt-style "cyan" (date now | format date "%H:%M:%S")
}

def create-left-prompt [leading_newline: string = ""] {
    let git_ctx = (prompt-git-context)
    let user_host = (prompt-join [(prompt-username) (prompt-hostname)])
    let segments = (prompt-join [
        (prompt-os)
        $user_host
        (prompt-directory $git_ctx)
        (prompt-rust)
        (prompt-python)
        (prompt-conda)
        (prompt-git-branch $git_ctx)
        (prompt-git-state $git_ctx)
        (prompt-git-status $git_ctx)
    ])

    $"($leading_newline)(prompt-prefix '╭─ ')($segments)\n(prompt-prefix '╰─ ')"
}

def create-right-prompt [] {
    prompt-join [
        (prompt-right-duration)
        (prompt-right-time)
    ] (prompt-style "dark_gray" " · ")
}

# Render the mode indicator in Nushell. Successful commands use green or
# magenta; failures use red.
def prompt-indicator [success_style: string, error_style: string, symbol: string] {
    if $env.LAST_EXIT_CODE == 0 {
        $"(ansi $success_style)($symbol) (ansi reset)"
    } else {
        $"(ansi $error_style)($symbol) (ansi reset)"
    }
}

export-env {
    $env.config.edit_mode = "vi"
    $env.config.render_right_prompt_on_last_line = false

    $env.PROMPT_COMMAND = {|| create-left-prompt "\n" }
    $env.PROMPT_COMMAND_RIGHT = {|| create-right-prompt }

    $env.PROMPT_INDICATOR = ""
    $env.PROMPT_INDICATOR_VI_INSERT = {|| prompt-indicator "green_bold" "red_bold" "❯" }
    $env.PROMPT_INDICATOR_VI_NORMAL = {|| prompt-indicator "magenta_bold" "red_bold" "❮" }
    $env.PROMPT_MULTILINE_INDICATOR = $"(ansi dark_gray)· (ansi reset)"

    $env.TRANSIENT_PROMPT_INDICATOR = ""
    $env.TRANSIENT_PROMPT_INDICATOR_VI_INSERT = {|| prompt-indicator "green_bold" "red_bold" "❯" }
    $env.TRANSIENT_PROMPT_INDICATOR_VI_NORMAL = {|| prompt-indicator "magenta_bold" "red_bold" "❮" }
    $env.TRANSIENT_PROMPT_MULTILINE_INDICATOR = ""
    $env.TRANSIENT_PROMPT_COMMAND = {|| create-left-prompt "\n" }
    $env.TRANSIENT_PROMPT_COMMAND_RIGHT = {|| create-right-prompt }
}
