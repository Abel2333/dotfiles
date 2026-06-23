# Nix-specific environment customizations.

use $"($nu.default-config-dir)/lib/path.nu" prepend-paths

def append-colon-entries [current: string, entries: list<string>] {
    let current_entries = (
        if ($current | str trim) == "" {
            []
        } else {
            $current | split row ":"
        }
    )

    (
        $current_entries
        ++ (
            $entries
            | where {|entry| $entry != "" and not ($current_entries | any {|existing| $existing == $entry})}
        )
    ) | str join ":"
}

let nix_state_home = ($env | get --optional NIX_STATE_HOME)
let xdg_state_home = (
    $env
    | get --optional XDG_STATE_HOME
    | default ($nu.home-dir | path join ".local" "state")
)

let legacy_link = ($nu.home-dir | path join ".nix-profile")
let state_link = ($xdg_state_home | path join "nix" "profile")

let nix_link = if $nix_state_home != null {
    $nix_state_home | path join "profile"
} else if ($state_link | path exists) {
    $state_link
} else {
    $legacy_link
}

let nix_profiles = [
    "/nix/var/nix/profiles/default",
    $nix_link,
] | uniq

$env.NIX_PROFILES = ($nix_profiles | str join " ")

let nix_profile_bins = ($nix_profiles | each {|profile| $profile | path join "bin"})

prepend-paths $nix_profile_bins

let nix_share_dirs = ($nix_profiles | each {|profile| $profile | path join "share"})
let xdg_data_dirs = ($env | get --optional XDG_DATA_DIRS | default "")

$env.XDG_DATA_DIRS = if ($xdg_data_dirs | str trim) == "" {
    append-colon-entries "/usr/local/share:/usr/share" $nix_share_dirs
} else {
    append-colon-entries $xdg_data_dirs $nix_share_dirs
}

if (($env | get --optional NIX_SSL_CERT_FILE) == null) {
    let system_cert = (
        [
            "/etc/ssl/certs/ca-certificates.crt",
            "/etc/ssl/ca-bundle.pem",
            "/etc/ssl/certs/ca-bundle.crt",
            "/etc/pki/tls/certs/ca-bundle.crt",
        ]
        | where {|path| $path | path exists}
        | first
    )

    if $system_cert != null {
        $env.NIX_SSL_CERT_FILE = $system_cert
    } else {
        let profile_cert = (
            (
                $nix_profiles
                | each {|profile| $profile | path join "etc" "ssl" "certs" "ca-bundle.crt"}
            )
            ++ [
                ($nix_link | path join "etc" "ca-bundle.crt"),
            ]
            | where {|path| $path | path exists}
            | first
        )

        if $profile_cert != null {
            $env.NIX_SSL_CERT_FILE = $profile_cert
        }
    }
}

# $env.TERMINFO_DIRS = $"($nu.home-dir)/.nix-profile/share/terminfo:"
# $env.TERMINFO = ""
