# Create a directory and enter it immediately.
#
# Examples:
#   Create a new project folder and change into it.
#   > mkcd demo-app
#
#   Create a directory from pipeline input and change into it.
#   > "demo-app" | mkcd
export def --env mkcd [dir?: path]: [ nothing -> nothing, string -> nothing ] {
    let raw = if $dir == null { $in } else { $dir }
    if $raw == null {
        error make { msg: "Provide a directory path as an argument or via pipeline" }
    }

    let target = ($raw | path expand)
    mkdir $target
    if ($env.LAST_EXIT_CODE != 0) { return }
    cd $target
}

# Create a timestamped backup beside a file or directory.
#
# Examples:
#   Backup a config file next to the original.
#   > bak ~/.zshrc
#
#   Backup a file path provided through the pipeline.
#   > ls ~/.zshrc | get name | first | bak
#
#   Backup the first matching file record from a listing.
#   > ll | where name has txt | first | bak
export def bak [target?: path]: [ nothing -> path, string -> path, record -> path ] {
    let raw = if $target != null {
        $target
    } else if (($in | describe) | str starts-with "record") {
        $in.name
    } else {
        $in
    }

    if $raw == null {
        error make { msg: "Provide a target path as an argument or via pipeline" }
    }

    let p = ($raw | path expand)
    let stamp = (date now | format date "%Y%m%d-%H%M%S")
    let dst = $"($p).bak.($stamp)"
    cp -r $p $dst
    $dst
}

def _require_cmd [cmd: string] {
    if ((which $cmd | length) == 0) {
        error make { msg: $"Required command not found: ($cmd)" }
    }
}

# Extract an archive based on its file extension.
#
# Examples:
#   Extract a zip archive in the current directory.
#   > extract archive.zip
#
#   Extract an archive into a specific target directory.
#   > extract archive.tar.gz --to ./out
#
#   Extract an archive path provided through the pipeline.
#   > "archive.tar.gz" | extract
#
#   Extract the first matching archive record from a listing.
#   > ll | where name has ".zip" | first | extract --to ./out
export def extract [source?: path, --to(-t): path]: [ nothing -> nothing, string -> nothing, record -> nothing ] {
    let raw = if $source != null {
        $source
    } else if (($in | describe) | str starts-with "record") {
        $in.name
    } else {
        $in
    }

    if $raw == null {
        error make { msg: "Provide an archive path as an argument or via pipeline" }
    }

    let p = ($raw | path expand)
    if not ($p | path exists) {
        error make { msg: $"Archive not found: ($p)" }
    }

    let out_dir = if $to == null {
        $env.PWD
    } else {
        ($to | path expand)
    }
    mkdir $out_dir

    let lower = ($p | str downcase)

    if ($lower | str ends-with ".tar.gz") or ($lower | str ends-with ".tgz") {
        _require_cmd tar
        ^tar -xzf $p -C $out_dir
    } else if ($lower | str ends-with ".tar.bz2") or ($lower | str ends-with ".tbz2") {
        _require_cmd tar
        ^tar -xjf $p -C $out_dir
    } else if ($lower | str ends-with ".tar.xz") or ($lower | str ends-with ".txz") {
        _require_cmd tar
        ^tar -xJf $p -C $out_dir
    } else if ($lower | str ends-with ".tar.zst") or ($lower | str ends-with ".tzst") {
        _require_cmd tar
        ^tar --zstd -xf $p -C $out_dir
    } else if ($lower | str ends-with ".tar") {
        _require_cmd tar
        ^tar -xf $p -C $out_dir
    } else if ($lower | str ends-with ".zip") {
        _require_cmd unzip
        ^unzip $p -d $out_dir
    } else if ($lower | str ends-with ".gz") {
        _require_cmd gzip
        ^gzip -dkc $p | save -f ($out_dir | path join ($p | path parse | get stem))
    } else if ($lower | str ends-with ".bz2") {
        _require_cmd bzip2
        ^bzip2 -dkc $p | save -f ($out_dir | path join ($p | path parse | get stem))
    } else if ($lower | str ends-with ".xz") {
        _require_cmd xz
        ^xz -dkc $p | save -f ($out_dir | path join ($p | path parse | get stem))
    } else if ($lower | str ends-with ".zst") {
        _require_cmd zstd
        ^zstd -dkc $p | save -f ($out_dir | path join ($p | path parse | get stem))
    } else if ($lower | str ends-with ".7z") {
        _require_cmd 7z
        ^7z x $"-o($out_dir)" $p
    } else if ($lower | str ends-with ".rar") {
        if ((which unrar | length) > 0) {
            ^unrar x $p $out_dir
        } else {
            _require_cmd 7z
            ^7z x $"-o($out_dir)" $p
        }
    } else {
        error make { msg: $"Unsupported archive format: ($p)" }
    }
}

# Move up parent directories from the current working directory.
#
# Examples:
#   Move up three directory levels.
#   > up 3
export def --env up [n: int = 1]: nothing -> nothing {
    cd (0..<$n | reduce -f "." { |_, acc| $acc | path join ".." })
}

# Resolve list targets for listing helpers.
#
# Examples:
#   Expand the given paths for downstream listing commands.
#   > _ls_targets src tests
def --env _ls_targets [...paths: string] {
    if ($paths | is-empty) {
        ["."]
    } else {
        $paths | each { |p| $p | path expand }
    }
}

# Adjust displayed names in listing output.
#
# Examples:
#   Relativize names when listing a single directory target.
#   > ls --long src | _ls_relativize $in [($'($env.PWD)/src')]
def _ls_relativize [result: table, targets: list<string>] {
    if ($targets == ["."]) {
        return $result
    }

    if ($targets | length) == 1 {
        let base = $targets | first
        return ($result | update name { |row| $row.name |  path relative-to $base })
    }

    return $result
}

# Add ANSI colors to file names for custom listing helpers.
#
# Examples:
#   Colorize file names after reshaping `ls` output.
#   > ls --long --short-names | select name type mode | _ls_colorize_name
def _ls_colorize_name [base_dir?: string]: table -> table {
    $in | update name { |row|
        let plain = $row.name
        let symlink_color = if $row.type == symlink {
            let target_path = if ($row.target | is-empty) {
                null
            } else if ($row.target | path type) != null {
                $row.target
            } else if ($base_dir != null) {
                $base_dir | path join $row.target
            } else {
                null
            }

            if ($target_path != null) and (($target_path | path type) == dir) {
                (ansi cyan_bold)
            } else {
                (ansi cyan)
            }
        } else {
            ""
        }

        let color = if $row.type == dir {
            (ansi blue_bold)
        } else if $row.type == symlink {
            $symlink_color
        } else if $row.type == socket {
            (ansi magenta)
        } else if $row.type == pipe {
            (ansi yellow)
        } else if (($row.mode | into string) | str contains "x") {
            (ansi green)
        } else {
            ""
        }

        if $color == "" {
            $plain
        } else {
            $"($color)($plain)(ansi reset)"
        }
    }
}

# List files including hidden entries with long-format metadata.
#
# Examples:
#   List all files, including hidden ones, in the current directory.
#   > l
export def l [--full-paths, ...paths: string]: nothing -> table {
    let targets = _ls_targets ...$paths
    let color_base = if ($targets | length) == 1 { $targets | first } else { null }

    if $full_paths {
        ls --all --long ...$targets
        | select name type mode group user size modified
    } else {
        ls --all --long --short-names ...$targets
        | select name type target mode group user size modified
        | _ls_colorize_name $color_base
        | reject target
    }
}

# List files without hidden entries using long-format metadata.
#
# Examples:
#   List visible files in a directory with detailed metadata.
#   > ll ~/.config
export def ll [--full-paths, ...paths: string]: nothing -> table {
    let targets = _ls_targets ...$paths
    let color_base = if ($targets | length) == 1 { $targets | first } else { null }

    if $full_paths {
        ls --long ...$targets
        | select name type mode group user size modified
    } else {
        ls --long --short-names ...$targets
        | select name type target mode group user size modified
        | _ls_colorize_name $color_base
        | reject target
    }
}

# Load variables from a dotenv-style file into the current shell session.
#
# Examples:
#   Load variables from the default .env file.
#   > load-env-file
#
#   Load variables from a specific file.
#   > load-env-file .env.local
export def --env load-env-file [file: string=".env"]: nothing -> nothing {
    let p = ($file | path expand)
    if not ($p | path exists) {
        error make { msg: $"File not found: ($p)" }
    }

 let vars = (
        open $p
        | lines
        | where { |l| ($l | str trim | str length) > 0 and not ($l | str trim | str starts-with "#") }
        | each { |l|
            let parts = ($l | split row "=" --number 2)  # only split on the first `=`
            { key: ($parts | first | str trim), value: ($parts | last | str trim) }
        }
    )

    $env._LOADED_ENV_KEYS = ($vars | get key)
    load-env ($vars | transpose -r | first)
    print $"Loaded ($vars | length) variables from ($p)"
}

# Remove variables that were previously loaded by `load-env-file`.
#
# Examples:
#   Unset variables loaded from the last env file.
#   > unload-env-file
export def --env unload-env-file []: nothing -> nothing {
    let keys = ($env | get -o _LOADED_ENV_KEYS | default [])
    if ($keys | is-empty) {
        print "No env file loaded"
        return
    }
    hide-env ...$keys
    hide-env _LOADED_ENV_KEYS
    print $"Unloaded ($keys | length) variables"
}
