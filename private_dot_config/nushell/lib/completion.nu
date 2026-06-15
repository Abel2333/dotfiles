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

def ssh-config-hosts [] {
    let ssh_config = ($env.HOME | path join ".ssh" "config")
    if not ($ssh_config | path exists) {
        return []
    }

    open $ssh_config
    | lines
    | where { |line| $line =~ '^\s*[Hh][Oo][Ss][Tt]\s+' }
    | each { |line|
        $line
        | str replace --regex '\s+#.*$' ''
        | str replace --regex '^\s*[Hh][Oo][Ss][Tt]\s+' ''
        | split row --regex '\s+'
        | where { |pattern|
            let item = ($pattern | str trim)
            ($item != "") and ($item !~ '[*?]') and ($item !~ '^!')
        }
    }
    | flatten
    | uniq
    | sort
}

def ssh-completion-request [spans: list<string>, trailing_space: bool] {
    if ($spans | is-empty) {
        return null
    }

    let count = ($spans | length)

    if (($spans | get 0) == "ssh") {
        let args = ($spans | skip 1)
        return {
            prefix: (current-prefix $args $trailing_space)
            replace_current: true
            command_prefix: ""
        }
    }

    if ($count >= 2) and (($spans | get 0) == "k") and (($spans | get 1) == "ssh") {
        let args = ($spans | skip 2)
        let replace_current = (($args | is-not-empty) or $trailing_space)
        return {
            prefix: (current-prefix $args $trailing_space)
            replace_current: $replace_current
            command_prefix: "ssh "
        }
    }

    if ($count >= 3) and (($spans | get 0) == "kitty") and (($spans | get 1) == "+kitten") and (($spans | get 2) == "ssh") {
        let args = ($spans | skip 3)
        let replace_current = (($args | is-not-empty) or $trailing_space)
        return {
            prefix: (current-prefix $args $trailing_space)
            replace_current: $replace_current
            command_prefix: "ssh "
        }
    }

    null
}

def ssh-host-completions [spans: list<string>] {
    let request = (ssh-completion-request $spans (has-trailing-space))
    if $request == null {
        return []
    }

    filter-prefix-ci (ssh-config-hosts) $request.prefix
    | each { |host|
        let value = (completion-value $host $request.replace_current $request.command_prefix)
        {
            value: $value
            display: $host
            description: "ssh host"
        }
    }
}

def container-completion-mode [subcommand: string] {
    if ($subcommand in ["stop" "restart" "kill" "exec" "attach" "top" "pause" "unpause"]) {
        "running"
    } else if ($subcommand in ["start" "rm" "inspect" "logs" "wait"]) {
        "all"
    } else {
        null
    }
}

def container-completion-request-for [spans: list<string>, trailing_space: bool] {
    if ($spans | is-empty) {
        return null
    }

    let engine = ($spans | get 0)
    if $engine not-in ["docker" "podman"] {
        return null
    }

    let parse = if (($spans | length) >= 3) and (($spans | get 1) == "container") {
        {
            subcommand: ($spans | get 2)
            args: ($spans | skip 3)
        }
    } else if (($spans | length) >= 2) {
        {
            subcommand: ($spans | get 1)
            args: ($spans | skip 2)
        }
    } else {
        return null
    }

    let mode = (container-completion-mode $parse.subcommand)
    if $mode == null {
        return null
    }

    if (($parse.args | is-empty) and (not $trailing_space)) {
        return null
    }

    let prefix = if $trailing_space {
        ""
    } else {
        $parse.args | last
    }
    let used_count = if $trailing_space {
        $parse.args | length
    } else {
        ($parse.args | length) - 1
    }
    let used = if $used_count <= 0 {
        []
    } else {
        $parse.args | first $used_count
    }

    {
        engine: $engine
        subcommand: $parse.subcommand
        mode: $mode
        prefix: $prefix
        used: $used
    }
}

def container-completion-request [spans: list<string>] {
    container-completion-request-for $spans (has-trailing-space)
}

def container-records [engine: string, mode: string] {
    let args = if $mode == "running" {
        ["ps" "--format" "{{.Names}}\t{{.Image}}\t{{.Status}}"]
    } else {
        ["ps" "-a" "--format" "{{.Names}}\t{{.Image}}\t{{.Status}}"]
    }

    try {
        run-external $engine ...$args
        | lines
        | parse "{name}\t{image}\t{status}"
        | where { |row| ($row.name | str trim) != "" }
    } catch {
        []
    }
}

def docker-podman-container-completions [spans: list<string>] {
    let request = (container-completion-request $spans)
    if $request == null {
        return []
    }

    container-records $request.engine $request.mode
    | where { |row| $row.name not-in $request.used }
    | where { |row| ($request.prefix | is-empty) or ($row.name | str starts-with $request.prefix) }
    | each { |row|
        {
            value: $"($row.name) "
            display: $row.name
            description: $row.status
        }
    }
}

export def external-custom-completions [spans: list<string>] {
    let ssh = (ssh-host-completions $spans)
    if ($ssh | is-not-empty) {
        $ssh
    } else {
        docker-podman-container-completions $spans
    }
}
