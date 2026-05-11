export def --env ls-targets [...paths: string] {
    if ($paths | is-empty) {
        ["."]
    } else {
        $paths | each { |p| $p | path expand }
    }
}

export def ls-relativize [result: table, targets: list<string>] {
    if ($targets == ["."]) {
        return $result
    }

    if ($targets | length) == 1 {
        let base = $targets | first
        return ($result | update name { |row| $row.name | path relative-to $base })
    }

    $result
}

export def ls-colorize-name [base_dir?: string]: table -> table {
    $in | update name { |row|
        let plain = $row.name
        let symlink_color = if $row.type == symlink {
            let target_path = if ($row.target | is-empty) {
                null
            } else if ($row.target | path type) != null {
                $row.target
            } else if ($base_dir != null) {
                $base_dir | path join $row.target
            } else {
                null
            }

            if ($target_path != null) and (($target_path | path type) == dir) {
                (ansi cyan_bold)
            } else {
                (ansi cyan)
            }
        } else {
            ""
        }

        let color = if $row.type == dir {
            (ansi blue_bold)
        } else if $row.type == symlink {
            $symlink_color
        } else if $row.type == socket {
            (ansi magenta)
        } else if $row.type == pipe {
            (ansi yellow)
        } else if (($row.mode | into string) | str contains "x") {
            (ansi green)
        } else {
            ""
        }

        if $color == "" {
            $plain
        } else {
            $"($color)($plain)(ansi reset)"
        }
    }
}
