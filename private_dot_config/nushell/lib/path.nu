# PATH helper: prepend directories to PATH.
# Only adds directories that actually exist, and skips ones already present.
export def --env prepend-paths [paths: list<string>] {
    let current = $env.PATH | default []
    let new_paths = $paths | where {|p| ($p | path exists) and ($p not-in $current)}

    if not ($new_paths | is-empty) {
        $env.PATH = ($new_paths | append $current)
    }
}
