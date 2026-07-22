const LIB_DIR = ($nu.default-config-dir | path join "lib")

use $"($LIB_DIR)/ui.nu"

export def fzf-rows [] {
    let history_long = (history --long)
    let raw_history_rows = (
        $history_long
        | reverse
        | uniq-by command
    )
    let raw_history_columns = (try { $raw_history_rows | columns } catch { [] })
    let rows = (
        $raw_history_rows
        | enumerate
        | each { |row|
            {
                id: (
                    $row.index
                    | into string
                )
                command: $row.item.command
                age: (
                    try {
                        $row.item
                        | get start_timestamp
                        | date humanize
                    } catch {
                        ""
                    }
                )
                status: (
                    try {
                        $row.item.exit_status
                    } catch {
                        0
                    }
                )
            }
        }
    )

    { rows: $rows }
}

export def fzf-entries [rows: list<any>] {
    let sep = (char tab)
    let age_width = 14
    let index_width = (
        $rows
        | get id
        | each { |id| $id | str length }
        | math max
        | default 1
    )
    let command_indent = (
        0..<($index_width + 1 + $age_width + 1)
        | each { " " }
        | str join ""
    )
    let wrap_sign = $"($command_indent)↳ "
    let entries = (
        $rows
        | each { |row|
            let padded_id = (ui pad-right-aligned $row.id $index_width)
            let command_color = if $row.status == 0 {
                ansi green
            } else {
                ansi red
            }
            let age_col = (ui pad-right-aligned $row.age $age_width)
            let age_display = $"(ansi cyan_dimmed)($age_col)(ansi reset)"
            let display = (
                $row.command
                | lines
                | enumerate
                | each { |line|
                    if $line.index == 0 {
                        $"($padded_id)($sep)($age_display)($sep)($command_color)($line.item)(ansi reset)"
                    } else {
                        $"($command_indent)($command_color)($line.item)(ansi reset)"
                    }
                }
                | str join (char newline)
            )

            {
                id: $row.id
                command: $row.command
                display: $display
            }
        }
    )

    {
        wrap_sign: $wrap_sign
        nth: '3..,..'
        entries: $entries
    }
}

export def selected-command [
    selected: string,
    query: string,
    entries: list<any>,
] {
    if ($selected | is-empty) {
        return $query
    }

    let sep = (char tab)
    let selected_id = (
        $selected | split column $sep id age rest | get id.0 | str trim
    )
    let selected_entry = (
        $entries
        | where id == $selected_id
        | first
    )

    if $selected_entry == null {
        $query
    } else {
        $selected_entry.command
    }
}
