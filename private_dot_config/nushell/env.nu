# env.nu
#

const CONFIG_DIR = $nu.default-config-dir
const CACHE_DIR = $nu.cache-dir

use $"($CONFIG_DIR)/lib/path.nu" prepend-paths

##########
#  Path  #
##########
if $nu.os-info.family == "unix" {
    source $"($CONFIG_DIR)/modules/platform/unix.nu"
    source $"($CONFIG_DIR)/modules/platform/nix.nu"
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
prepend-paths [$env.PNPM_HOME]

###########
#  vcpkg  #
###########
let vcpkg_root = ($nu.home-dir | path join "Tools" "vcpkg")
if ($vcpkg_root | path exists) {
    $env.VCPKG_ROOT = $vcpkg_root

    let vcpkg_executable = ($vcpkg_root | path join "vcpkg")
    if ($vcpkg_executable | path exists) {
        prepend-paths [$vcpkg_root]
    }
}

############
#  Prompt  #
############
use $"($CONFIG_DIR)/modules/prompt.nu" *

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
# if not (which fnm | is-empty) {
#     fnm env --json | from json | load-env
#     prepend-paths [($env.FNM_MULTISHELL_PATH | path join "bin")]
# }

#############
#  Secrets  #
#############
source $"($CONFIG_DIR)/secrets.nu"
