export def require-cmd [cmd: string] {
    if ((which $cmd | length) == 0) {
        error make { msg: $"Required command not found: ($cmd)" }
    }
}

export def editor-command [] {
    let editor = (
        $env
        | get --optional VISUAL
        | default ($env | get --optional EDITOR)
        | default "nvim"
    )
    let parts = ($editor | split words)

    if ($parts | is-empty) {
        error make { msg: "EDITOR/VISUAL is empty" }
    }

    require-cmd ($parts | first)
    $parts
}
