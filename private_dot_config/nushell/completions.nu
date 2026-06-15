use ~/.config/nushell/lib/completion.nu

# Custom completions layered on top of the existing external completer.
#
# This keeps the current carapace integration as the fallback, and only
# intercepts docker/podman container-name completion for subcommands where Nu's
# external-completer bridge tends to miss the trailing empty argument.

let configured_external_completer = (
    $env.config
    | get --optional completions.external.completer
)
let fallback_external_completer = if $configured_external_completer == null {
    { |_| [] }
} else {
    $configured_external_completer
}

let wrapped_external_completer = {|spans: list<string>|
    let custom = (completion external-custom-completions $spans)
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
