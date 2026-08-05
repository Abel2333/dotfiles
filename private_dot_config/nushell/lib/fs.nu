# Extract a path string from an explicit argument or pipeline input.
# If the pipeline input is a record (for example from `ls`), use its `name` field.
export def path-from-input [explicit?: path] {
    if $explicit != null {
        $explicit
    } else if (($in | describe) | str starts-with "record") {
        $in.name
    } else {
        $in
    }
}

export def --env ls-targets [...paths: string] {
    if ($paths | is-empty) {
        ["."]
    } else {
        $paths | each { |p| $p | path expand }
    }
}
