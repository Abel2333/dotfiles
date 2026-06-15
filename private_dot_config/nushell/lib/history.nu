use ~/.config/nushell/lib/ui.nu

export def timestamp-column [columns: list<string>] {
    $columns
    | where { |name| $name in ["start_timestamp", "timestamp", "time", "start_time"] }
    | first
}

export def timestamp-display [timestamp: any] {
    let dt = if (($timestamp | describe) == "datetime") {
        $timestamp
    } else {
        try { $timestamp | into datetime } catch { null }
    }

    if $dt == null {
        return ""
    }

    let age = (date now) - $dt
    let mins = (($age / 1min) | math floor | into int)
    let hours = (($age / 1hr) | math floor | into int)
    let days = (($age / 1day) | math floor | into int)

    if $age < 1min {
        "now"
    } else if $age < 2min {
        "a minute ago"
    } else if $age < 1hr {
        $"($mins) minutes ago"
    } else if $age < 2hr {
        "an hour ago"
    } else if $age < 1day {
        $"($hours) hours ago"
    } else if $age < 2day {
        "a day ago"
    } else if $age < 90day {
        $"($days) days ago"
    } else {
        $dt | format date "%Y-%m-%d %H:%M"
    }
}

export def fzf-rows [] {
    let history_long = (history --long)
    let history_columns = (try { $history_long | columns } catch { [] })
    let ts_column = (timestamp-column $history_columns)
    let raw_history_rows = (
        if $ts_column == null {
            history
            | reverse
            | uniq-by command
        } else {
            $history_long
            | reverse
            | uniq-by command
        }
    )
    let raw_history_columns = (try { $raw_history_rows | columns } catch { [] })
    let has_history_index = ("index" in $raw_history_columns)
    let has_timestamps = ($ts_column != null)
    let rows = (
        $raw_history_rows
        | enumerate
        | each { |row|
            {
                id: (
                    if $has_history_index {
                        $row.item.index
                    } else {
                        $row.index
                    }
                    | into string
                )
                command: $row.item.command
                age: (
                    if $has_timestamps {
                        timestamp-display ($row.item | get $ts_column)
                    } else {
                        ""
                    }
                )
            }
        }
    )

    {
        has_timestamps: $has_timestamps
        rows: $rows
    }
}

export def fzf-entries [rows: list<any>, has_timestamps: bool] {
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
        0..<(
            if $has_timestamps {
                $index_width + 1 + $age_width + 1
            } else {
                $index_width + 1
            }
        )
        | each { " " }
        | str join ""
    )
    let wrap_sign = $"($command_indent)↳ "
    let entries = (
        $rows
        | each { |row|
            let padded_id = (ui pad-right-aligned $row.id $index_width)
            let age_display = if $has_timestamps {
                let age_col = (ui pad-right-aligned $row.age $age_width)
                $"(ansi cyan_dimmed)($age_col)(ansi reset)"
            } else {
                ""
            }
            let display = (
                $row.command
                | lines
                | enumerate
                | each { |line|
                    if $line.index == 0 {
                        if $has_timestamps {
                            $"($padded_id)($sep)($age_display)($sep)($line.item)"
                        } else {
                            $"($padded_id)($sep)($line.item)"
                        }
                    } else {
                        $"($command_indent)($line.item)"
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
        nth: (if $has_timestamps { '3..,..' } else { '2..,..' })
        entries: $entries
    }
}

export def selected-command [
    selected: string,
    query: string,
    entries: list<any>,
    has_timestamps: bool,
] {
    if ($selected | is-empty) {
        return $query
    }

    let sep = (char tab)
    let selected_id = (
        if $has_timestamps {
            $selected | split column $sep id age rest | get id.0 | str trim
        } else {
            $selected | split column $sep id rest | get id.0 | str trim
        }
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
