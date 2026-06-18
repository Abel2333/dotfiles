# env.nu
#

const CONFIG_DIR = $nu.default-config-dir
const CACHE_DIR = $nu.cache-dir

##########
#  Path  #
##########
if $nu.os-info.family == "unix" {
    source $"($CONFIG_DIR)/modules/platform/unix.nu"
}

if $nu.os-info.name == "linux" {
    source $"($CONFIG_DIR)/modules/platform/linux.nu"
}

############
#  Editor  #
############
$env.EDITOR = 'nvim'
$env.VISUAL = 'nvim'

############
#  Locale  #
############
$env.LANG = 'en_US.UTF-8'
$env.LC_CTYPE = 'zh_CN.UTF-8'
$env.LC_TIME = 'C.UTF-8'

#############
#  Python   #
#############
$env.VIRTUAL_ENV_DISABLE_PROMPT = "1"

############
#  Zoxide  #
############
zoxide init nushell | save -f $"($CACHE_DIR)/zoxide.nu"

##########
#  PNPM  #
##########
$env.PNPM_HOME = ($nu.home-dir | path join ".local" "share" "pnpm")

# Add only once to avoid duplicating the PNPM bin directory.
if not ($env.PATH | any {|p| $p == $env.PNPM_HOME}) {
    $env.PATH = ($env.PATH | prepend $env.PNPM_HOME)
}

############
#  Prompt  #
############
# Use vi editing mode in Nushell.
$env.config.edit_mode = "vi"

# Keep the right prompt on the first line so it stays aligned with the header.
$env.config.render_right_prompt_on_last_line = false

const PROMPT_HOST_INFO = (sys host)

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

def prompt-os-symbol [] {
    let os_name = ($PROMPT_HOST_INFO.name | str downcase)

    if ($os_name | str contains "arch") {
        "󰣇 "
    } else if ($os_name | str contains "debian") {
        " "
    } else if ($os_name | str contains "fedora") {
        " "
    } else if ($os_name | str contains "gentoo") {
        " "
    } else if ($os_name | str contains "ubuntu") {
        " "
    } else if $nu.os-info.name == "windows" {
        " "
    } else {
        " "
    }
}

def prompt-home-relative [cwd: string] {
    if $cwd == $nu.home-dir {
        "~"
    } else if ($cwd | str starts-with $nu.home-dir) {
        let rel = ($cwd | path relative-to $nu.home-dir)
        if $rel == "." {
            "~"
        } else {
            $"~/($rel)"
        }
    } else {
        $cwd
    }
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

def prompt-directory [] {
    prompt-style "#89B4FA" $"(prompt-home-relative $env.PWD) "
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
    let user_host = (prompt-join [(prompt-username) (prompt-hostname)])
    let segments = (prompt-join [
        (prompt-os)
        $user_host
        (prompt-directory)
        (prompt-rust)
        (prompt-python)
        (prompt-conda)
    ])

    $"($leading_newline)(prompt-prefix '╭─ ')($segments)\n(prompt-prefix '╰─ ')"
}

def create-right-prompt [] {
    prompt-join [
        (prompt-right-duration)
        (prompt-right-time)
    ] (prompt-style "dark_gray" " · ")
}

$env.PROMPT_COMMAND = {|| create-left-prompt "\n" }
$env.PROMPT_COMMAND_RIGHT = {|| create-right-prompt }

# Render the mode indicator in Nushell. Successful commands use green or
# magenta; failures use red.
def prompt-indicator [success_style: string, error_style: string, symbol: string] {
    if $env.LAST_EXIT_CODE == 0 {
        $"(ansi $success_style)($symbol) (ansi reset)"
    } else {
        $"(ansi $error_style)($symbol) (ansi reset)"
    }
}

$env.PROMPT_INDICATOR = ""
$env.PROMPT_INDICATOR_VI_INSERT = {|| prompt-indicator "green_bold" "red_bold" "❯" }
$env.PROMPT_INDICATOR_VI_NORMAL = {|| prompt-indicator "magenta_bold" "red_bold" "❮" }
$env.PROMPT_MULTILINE_INDICATOR = $"(ansi dark_gray)· (ansi reset)"

# Keep the transient indicators aligned with the live prompt so rewritten
# scrollback preserves the same mode and status colors.
$env.TRANSIENT_PROMPT_INDICATOR = ""
$env.TRANSIENT_PROMPT_INDICATOR_VI_INSERT = {|| prompt-indicator "green_bold" "red_bold" "❯" }
$env.TRANSIENT_PROMPT_INDICATOR_VI_NORMAL = {|| prompt-indicator "magenta_bold" "red_bold" "❮" }
$env.TRANSIENT_PROMPT_MULTILINE_INDICATOR = ""
$env.TRANSIENT_PROMPT_COMMAND = {|| create-left-prompt "\n" }
$env.TRANSIENT_PROMPT_COMMAND_RIGHT = {|| create-right-prompt }

##############
#  Carapace  #
##############
$env.CARAPACE_BRIDGES = 'zsh,fish,bash,inshellisense' # Optional.
let cache_file = $"($nu.cache-dir)/carapace.nu"
let carapace_bin = (which carapace | get path.0)

let need_update = (
    (not ($cache_file | path exists))
    or
    (try { (ls $carapace_bin | get modified.0) > (ls $cache_file | get modified.0) } catch { true })
)

if $need_update {
    mkdir ($nu.cache-dir | into string)
    carapace _carapace nushell | save --force $cache_file
}

############
#  Nodejs  #
############
if not (which fnm | is-empty) {
    fnm env --json | from json | load-env
    $env.PATH = ($env.PATH | prepend ($env.FNM_MULTISHELL_PATH | path join "bin"))
}

#############
#  Secrets  #
#############
source $"($CONFIG_DIR)/secrets.nu"
