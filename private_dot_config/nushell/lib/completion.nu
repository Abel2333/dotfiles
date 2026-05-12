use ~/.config/nushell/lib/commandline.nu

export def has-trailing-space [] {
    let left = (commandline state).left
    ($left | is-not-empty) and ($left =~ '\s$')
}

export def current-prefix [args: list<string>, trailing_space: bool] {
    if $trailing_space {
        ""
    } else {
        $args | default "" | last
    }
}

export def filter-prefix-ci [items: list<string>, prefix: string] {
    let normalized = ($prefix | str downcase)
    if ($normalized | is-empty) {
        $items
    } else {
        $items | where { |item| (($item | str downcase) | str starts-with $normalized) }
    }
}

export def completion-value [candidate: string, replace_current: bool, command_prefix: string] {
    if $replace_current {
        $"($candidate) "
    } else {
        $"($command_prefix)($candidate) "
    }
}
