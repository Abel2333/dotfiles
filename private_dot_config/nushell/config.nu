# config.nu
#
# Installed by:
# version = "0.112.2"
#
# This file is used to override default Nushell settings, define
# (or import) custom commands, or run any other startup tasks.
# See https://www.nushell.sh/book/configuration.html
#
# Nushell sets "sensible defaults" for most configuration settings, 
# so your `config.nu` only needs to override these defaults if desired.
#
# You can open this file in your default editor using:
#     config nu
#
# You can also pretty-print and page through the documentation for configuration
# options using:
#     config nu --doc | nu-highlight | less -R

mkdir ($nu.data-dir | path join "vendor/autoload")
starship init nu | save -f ($nu.data-dir | path join "vendor/autoload/starship.nu")

# Functions
def --env _ls_targets [...paths: string] {
    if ($paths | is-empty) {
        ["."]
    } else {
        $paths | each { |p| $p | path expand }
    }
}

def _ls_relativize [result: table, targets: list<string>] {
    if ($targets == ["."]) {
        return $result
    }

    if ($targets | length) == 1 {
        let base = $targets | first
        return ($result | update name { |row| $row.name |  path relative-to $base })
    }

    return result
}

def l [...paths: string] {
    let targets = _ls_targets ...$paths
    ls --all --long ...$targets
    | select name type mode group user size modified
    | _ls_relativize $in $targets
}
def ll [...paths: string] {
    let targets = _ls_targets ...$paths
    ls --long ...$targets
    | select name type mode group user size modified
    | _ls_relativize $in $targets
}

# Alias
alias k = kitty +kitten
alias v = nvim
alias ac = aria2c -c -x 8 -s 8 -d ~/Downloads

# Zoxide
source ~/.zoxide.nu

# Carapace
source $"($nu.cache-dir)/carapace.nu"
