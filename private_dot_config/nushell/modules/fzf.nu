# Optional commands powered by fzf.

const LIB_DIR = ($nu.default-config-dir | path join "lib")
const FZF_PANEL_ARGS = ["--height", "100%", "--border"]

use $"($LIB_DIR)/commandline.nu"
use $"($LIB_DIR)/history.nu"
use $"($LIB_DIR)/system.nu"

# Fuzzy-pick a directory under the current working tree and `cd` into it.
export def --env fzf-cd [] {
    system require-cmd fzf
    system require-cmd fd

    let dir = (fd --type d --hidden --exclude .git | to text | ^fzf ...$FZF_PANEL_ARGS | str trim)
    if ($dir | is-not-empty) { cd $dir }
}

# Fuzzy-pick a command from history and insert it into the command line.
export def --env fzf-history [] {
    system require-cmd fzf

    let query = (commandline)
    commandline edit --replace ""

    let command = try {
        let nul = (char --integer 0)
        let sep = (char tab)
        let history_state = (history fzf-rows)
        let entry_config = (history fzf-entries $history_state.rows)
        let entries = $entry_config.entries
        let fzf_result = (
            $entries
            | each { |row| $row.display }
            | str join $nul
            | ^fzf
                ...$FZF_PANEL_ARGS
                --read0
                --scheme history
                --bind 'ctrl-r:toggle-sort'
                --highlight-line
                --wrap
                --wrap-sign $entry_config.wrap_sign
                --ansi
                --color 'hl:bright-white:bold,hl+:bright-white:bold'
                --tabstop 1
                --query $query
                --delimiter $sep
                --nth $entry_config.nth
                +m
            | complete
        )

        if $fzf_result.exit_code != 0 {
            $query
        } else {
            let selected = ($fzf_result.stdout | str trim)
            if ($selected | is-empty) {
                $query
            } else {
                history selected-command $selected $query $entries
            }
        }
    } catch {
        $query
    }

    commandline edit --replace $command
}

# Fuzzy-pick a file or directory and insert its path into the current command line.
export def --env fzf-file-insert [] {
    system require-cmd fzf
    system require-cmd fd

    let line = (commandline state)
    let left = $line.left
    let right = $line.right
    let selected_raw = (
        fd --hidden --exclude .git
        | to text
        | ^fzf ...$FZF_PANEL_ARGS
        | str trim
    )

    if ($selected_raw | is-not-empty) {
        let selected = if ($selected_raw =~ '^[[:alnum:]_./~-]+$') {
            $selected_raw
        } else {
            $selected_raw | to nuon
        }
        let spacer = if (($left | is-empty) or ($left | str ends-with " ")) {
            ""
        } else {
            " "
        }
        let next = $"($left)($spacer)($selected)($right)"
        commandline edit --replace $next
        commandline set-cursor (($left | str length) + ($spacer | str length) + ($selected | str length))
    }
}

# Search project contents with ripgrep, filter matches in fzf, and open the
# selected result in the configured editor at the matching line.
export def rg-fzf [pattern?: string]: nothing -> nothing {
    system require-cmd rg
    system require-cmd fzf

    let query = if $pattern == null { "" } else { $pattern }
    let editor = (system editor-command)
    let sep = (char --integer 31)
    let preview_script = ($nu.default-config-dir | path join "lib" "rg_preview.nu")
    let preview = $'"($nu.current-exe)" "($preview_script)" {1} {2}'
    let selected = (
        ^rg --json --color=never --smart-case $query
        | from json --objects
        | where { |row| $row.type == "match" }
        | each { |row|
            let file = $row.data.path.text
            let line = ($row.data.line_number | into string)
            let text = (
                $row.data.lines.text
                | str trim
                | str replace --all "\t" " "
            )
            let display = $"($file):($line): ($text)"
            [$file, $line, $display] | str join $sep
        }
        | to text
        | ^fzf ...$FZF_PANEL_ARGS --ansi --query $query --delimiter $sep --with-nth 3 --preview $preview
        | str trim
    )

    if ($selected | is-empty) {
        return
    }

    let parts = ($selected | split row $sep --number 3)
    let file = ($parts | get 0)
    let line = ($parts | get 1)
    run-external ...$editor $"+($line)" $file
}
