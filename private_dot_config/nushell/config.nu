# config.nu
#
# Installed by:
# version = "0.112.2"
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

use $"($CONFIG_DIR)/tools.nu" *

$env.STARSHIP_CONFIG = ($CONFIG_DIR | path join "starship.toml")

mkdir ($nu.data-dir | path join "vendor/autoload")
starship init nu | save -f ($nu.data-dir | path join "vendor/autoload/starship.nu")

# Alias
alias k = kitty +kitten
alias v = nvim
alias ac = aria2c -c -x 8 -s 8 -d $DOWNLOADS_DIR
alias lg = lazygit

# Zoxide
source $"($CACHE_DIR)/zoxide.nu"

# Carapace
source $"($nu.cache-dir)/carapace.nu"
source $"($CONFIG_DIR)/completions.nu"

$env.config.history.file_format = "sqlite"

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
] ++ $env.config.keybindings)
