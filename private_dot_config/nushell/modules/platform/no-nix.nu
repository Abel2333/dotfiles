# Remove Nix profile state inherited from parent processes.

export def --env sanitize-nix-environment [] {
    let is_nix_path = {|entry: string|
        (($entry | str starts-with "/nix/") or
            ($entry | str contains "/.nix-profile/") or
            ($entry | str contains "/.local/state/nix/profile/"))
    }

    $env.PATH = ($env.PATH | where {|entry| not (do $is_nix_path $entry)})

    if "XDG_DATA_DIRS" in $env {
        $env.XDG_DATA_DIRS = (
            $env.XDG_DATA_DIRS
            | split row ":"
            | where {|entry| not (do $is_nix_path $entry)}
            | str join ":"
        )
    }

    for name in ($env | columns | where {|name| $name | str starts-with "NIX_"}) {
        hide-env $name
    }
}
