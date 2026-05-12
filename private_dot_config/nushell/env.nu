# env.nu
#
# Installed by:
# version = "0.112.2"
#
# Previously, environment variables were typically configured in `env.nu`.
# In general, most configuration can and should be performed in `config.nu`
# or one of the autoload directories.
#
# This file is generated for backwards compatibility for now.
# It is loaded before config.nu and login.nu
#
# See https://www.nushell.sh/book/configuration.html
#
# Also see `help config env` for more options.
#
# You can remove these comments if you want or leave
# them for future reference.

##########
#  Path  #
##########
$env.GOBIN = $"($env.HOME)/.local/bin"
$env.PATH = ($env.PATH | prepend [
    $"($env.HOME)/.local/bin",
    "/usr/lib64/qt6/bin",
    $"($env.HOME)/.cargo/bin"
])
$env.PATH = ($env.PATH | prepend "/usr/local/cuda-13.0/bin")
$env.PATH = ($env.PATH | prepend $"($env.HOME)/.dotnet")

############
#  Zoxide  #
############
zoxide init nushell | save -f $"($env.HOME)/.zoxide.nu"

############
#  Editor  #
############
$env.EDITOR = 'nvim'
$env.VISUAL = 'nvim'

# Use vi editing mode in Nushell.
$env.config.edit_mode = "vi"

# Let Starship render the main prompt body and keep Nushell responsible for the
# mode indicator only. The indicator color reflects the last command status:
# green/magenta on success, red on failure.
$env.PROMPT_INDICATOR = ""
$env.PROMPT_INDICATOR_VI_INSERT = {||
    if $env.LAST_EXIT_CODE == 0 {
        $"(ansi green_bold)❯ (ansi reset)"
    } else {
        $"(ansi red_bold)❯ (ansi reset)"
    }
}
$env.PROMPT_INDICATOR_VI_NORMAL = {||
    if $env.LAST_EXIT_CODE == 0 {
        $"(ansi magenta_bold)❮ (ansi reset)"
    } else {
        $"(ansi red_bold)❮ (ansi reset)"
    }
}
$env.PROMPT_MULTILINE_INDICATOR = "::: "

# After a command runs, Nushell rewrites the previous prompt line using the
# transient prompt variables. Keep them aligned with the live prompt so the
# scrollback shows the same mode/status colors.
$env.TRANSIENT_PROMPT_INDICATOR = ""
$env.TRANSIENT_PROMPT_INDICATOR_VI_INSERT = {||
    if $env.LAST_EXIT_CODE == 0 {
        $"(ansi green_bold)❯ (ansi reset)"
    } else {
        $"(ansi red_bold)❯ (ansi reset)"
    }
}
$env.TRANSIENT_PROMPT_INDICATOR_VI_NORMAL = {||
    if $env.LAST_EXIT_CODE == 0 {
        $"(ansi magenta_bold)❮ (ansi reset)"
    } else {
        $"(ansi red_bold)❮ (ansi reset)"
    }
}
$env.TRANSIENT_PROMPT_MULTILINE_INDICATOR = ""

############
#  Locale  #
############
$env.LANG = 'en_US.UTF-8'
$env.LC_CTYPE = 'zh_CN.UTF-8'
$env.LC_TIME = 'C.UTF-8'

#############
#  OpenGPG  #
#############
$env.GPG_TTY = (^tty | str trim)
$env.SSH_AUTH_SOCK = (^gpgconf --list-dirs agent-ssh-socket | str trim)
^gpg-connect-agent updatestartuptty /bye o+e>| ignore

#########
#  LFS  #
#########
$env.LFS = '/mnt/lfs'

##########
#  PNPM  #
##########
$env.PNPM_HOME = $"($env.HOME)/.local/share/pnpm"
# Add only once, avoid duplication
if not ($env.PATH | any {|p| $p == $env.PNPM_HOME}) {
    $env.PATH = ($env.PATH | prepend $env.PNPM_HOME)
}

##############
#  Carapace  #
##############
$env.CARAPACE_BRIDGES = 'zsh,fish,bash,inshellisense' # optional
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
source ~/.config/nushell/secrets.nu
