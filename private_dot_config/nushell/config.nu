# config.nu
#
# Installed by:
# version = "0.113.1"
#
# This file is used to override default Nushell settings, define
# (or import) custom commands, or run any other startup tasks.
# See https://www.nushell.sh/book/configuration.html
#
# Nushell sets "sensible defaults" for most configuration settings, 
# so your `config.nu` only needs to override these defaults if desired.
#
# You can open this file in your default editor using:
#     config nu
#
# You can also pretty-print and page through the documentation for configuration
# options using:
#     config nu --doc | nu-highlight | less -R

const CONFIG_DIR = $nu.default-config-dir
const CACHE_DIR = $nu.cache-dir
const DOWNLOADS_DIR = ($nu.home-dir | path join "Downloads")
const DATA_DIR = ($CONFIG_DIR | path join "data")

# Mise
use ($nu.default-config-dir | path join "mise.nu")

use $"($CONFIG_DIR)/tools.nu" *
use $"($CONFIG_DIR)/modules/fzf.nu" *

let has_fzf = not (which fzf | is-empty)

# Alias
alias k = kitty +kitten
alias v = nvim
alias ac = aria2c -c -x 8 -s 8 -d $DOWNLOADS_DIR
alias lg = lazygit

# Zoxide
#
# Note: `source` must stay at the top level and only the path may be
# conditional. Wrapping `source` itself in `if` would scope the file's
# `export`ed definitions (like the `z` alias) to that block, silently
# dropping them once the block ends.
source (if ($"($CACHE_DIR)/zoxide.nu" | path exists) { $"($CACHE_DIR)/zoxide.nu" } else { "/dev/null" })

# Carapace
source (if (($nu.cache-dir | path join "carapace.nu") | path exists) { ($nu.cache-dir | path join "carapace.nu") } else { "/dev/null" })
source $"($CONFIG_DIR)/completions.nu"

mkdir $DATA_DIR
$env.config.history.path = ($DATA_DIR | path join "history.sqlite3")
$env.config.history.file_format = "sqlite"

let fzf_keybindings = if $has_fzf {
    [
        {
            name: fzf_file_insert
            modifier: control
            keycode: char_t
            mode: [emacs vi_normal vi_insert]
            event: {
                send: executehostcommand
                cmd: "fzf-file-insert"
            }
        }
        {
            name: fzf_history
            modifier: control
            keycode: char_r
            mode: [emacs vi_normal vi_insert]
            event: {
                send: executehostcommand
                cmd: "fzf-history"
            }
        }
        {
            name: fzf_cd
            modifier: alt
            keycode: char_c
            mode: [emacs vi_normal vi_insert]
            event: {
                send: executehostcommand
                cmd: "fzf-cd"
            }
        }
    ]
} else {
    []
}

$env.config.keybindings = ([
    {
        name: insert_newline
        modifier: control
        keycode: char_j
        mode: [emacs vi_insert]
        event: {
            edit: insertnewline
        }
    }
] ++ $fzf_keybindings ++ $env.config.keybindings)
