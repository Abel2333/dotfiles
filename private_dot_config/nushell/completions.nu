use ~/.config/nushell/lib/completion.nu *

# Custom completions layered on top of the existing external completer.
#
# This keeps the current carapace integration as the fallback, and only
# intercepts docker/podman container-name completion for subcommands where Nu's
# external-completer bridge tends to miss the trailing empty argument.

def _ssh_config_hosts [] {
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

def _ssh_completion_request [spans: list<string>, trailing_space: bool] {
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

def _ssh_host_completions [spans: list<string>] {
    let request = (_ssh_completion_request $spans (has-trailing-space))
    if $request == null {
        return []
    }

    filter-prefix-ci (_ssh_config_hosts) $request.prefix
    | each { |host|
        let value = (completion-value $host $request.replace_current $request.command_prefix)
        {
            value: $value
            display: $host
            description: "ssh host"
        }
    }
}

def _container_completion_mode [subcommand: string] {
    if ($subcommand in ["stop" "restart" "kill" "exec" "attach" "top" "pause" "unpause"]) {
        "running"
    } else if ($subcommand in ["start" "rm" "inspect" "logs" "wait"]) {
        "all"
    } else {
        null
    }
}

def _container_completion_request_for [spans: list<string>, trailing_space: bool] {
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

    let mode = (_container_completion_mode $parse.subcommand)
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

def _container_completion_request [spans: list<string>] {
    _container_completion_request_for $spans (has-trailing-space)
}

def _container_records [engine: string, mode: string] {
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

def _docker_podman_container_completions [spans: list<string>] {
    let request = (_container_completion_request $spans)
    if $request == null {
        return []
    }

    _container_records $request.engine $request.mode
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

let fallback_external_completer = (
    $env.config
    | get --optional completions.external.completer
    | default {|_: list<string>| [] }
)

def _custom_external_completions [spans: list<string>] {
    let ssh = (_ssh_host_completions $spans)
    if ($ssh | is-not-empty) {
        $ssh
    } else {
        _docker_podman_container_completions $spans
    }
}

let wrapped_external_completer = {|spans: list<string>|
    let custom = (_custom_external_completions $spans)
    if ($custom | is-not-empty) {
        $custom
    } else {
        do $fallback_external_completer $spans
    }
}

$env.config = (
    $env.config
    | upsert completions.external.enable true
    | upsert completions.external.completer { $wrapped_external_completer }
)
