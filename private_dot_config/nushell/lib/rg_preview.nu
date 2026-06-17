def main [file: string, line: int] {
    if not ($file | path exists) {
        return
    }

    let rows = (
        try {
            open --raw $file
            | decode utf-8
            | lines
        } catch {
            return
        }
    )

    if ($rows | is-empty) {
        return
    }

    let start = if $line > 3 { $line - 3 } else { 1 }
    let end = ($line + 3)
    let width = (($end | into string) | str length)

    $rows
    | slice (($start - 1)..($end - 1))
    | enumerate
    | each { |row|
        let line_no = ($start + $row.index)
        let prefix = ($line_no | fill --alignment right --character " " --width $width)

        if $line_no == $line {
            $"(ansi green_bold)> ($prefix) | (ansi reset)($row.item)"
        } else {
            $"  ($prefix) | ($row.item)"
        }
    }
    | str join (char newline)
    | print
}
