use ~/.config/nushell/lib/commandline.nu

# Custom completions layered on top of the existing external completer.
#
# This keeps the current carapace integration as the fallback, and only
# intercepts docker/podman container-name completion for subcommands where Nu's
# external-completer bridge tends to miss the trailing empty argument.

def _completion_has_trailing_space [] {
    let left = (commandline state).left
    ($left | is-not-empty) and ($left =~ '\s$')
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
    _container_completion_request_for $spans (_completion_has_trailing_space)
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

let wrapped_external_completer = {|spans: list<string>|
    let custom = (_docker_podman_container_completions $spans)
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
