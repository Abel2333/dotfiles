export def pad-right-aligned [text: string, width: int] {
    let len = ($text | str length)
    if $len >= $width {
        $text
    } else {
        let padding = (
            0..<(($width - $len))
            | each { " " }
            | str join ""
        )
        $"($padding)($text)"
    }
}
