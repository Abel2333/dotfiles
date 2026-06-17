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

# Render the mode indicator in Nushell and leave the main prompt body to
# Starship. Successful commands use green or magenta; failures use red.
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
$env.PROMPT_MULTILINE_INDICATOR = "::: "

# Keep the transient indicators aligned with the live prompt so rewritten
# scrollback preserves the same mode and status colors.
$env.TRANSIENT_PROMPT_INDICATOR = ""
$env.TRANSIENT_PROMPT_INDICATOR_VI_INSERT = {|| prompt-indicator "green_bold" "red_bold" "❯" }
$env.TRANSIENT_PROMPT_INDICATOR_VI_NORMAL = {|| prompt-indicator "magenta_bold" "red_bold" "❮" }
$env.TRANSIENT_PROMPT_MULTILINE_INDICATOR = ""

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
