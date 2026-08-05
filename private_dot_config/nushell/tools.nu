const LIB_DIR = ($nu.default-config-dir | path join "lib")

use $"($LIB_DIR)/fs.nu"
use $"($LIB_DIR)/system.nu"

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
    let raw = fs path-from-input $target

    if $raw == null {
        error make { msg: "Provide a target path as an argument or via pipeline" }
    }

    let p = ($raw | path expand)
    let stamp = (date now | format date "%Y%m%d-%H%M%S")
    let dst = $"($p).bak.($stamp)"
    cp -r $p $dst
    $dst
}

# Extract an archive based on its file extension.
#
# Examples:
#   Extract a zip archive into a new same-named directory in the current directory.
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
    let raw = fs path-from-input $source

    if $raw == null {
        error make { msg: "Provide an archive path as an argument or via pipeline" }
    }

    let p = ($raw | path expand)
    if not ($p | path exists) {
        error make { msg: $"Archive not found: ($p)" }
    }

    let out_dir = if $to == null {
        let archive_name = ($p | path basename)
        let dir_name = ($archive_name | str replace --regex '(?i)\.(tar\.(gz|bz2|xz|zst)|tgz|tbz2|txz|tzst|tar|zip|gz|bz2|xz|zst|7z|rar)$' '')
        let target = ($env.PWD | path join $dir_name)

        if ($target | path exists) {
            error make { msg: $"Extraction directory already exists: ($target)" }
        }

        mkdir $target
        $target
    } else {
        let target = ($to | path expand)
        mkdir $target
        $target
    }

    let lower = ($p | str downcase)

    if ($lower | str ends-with ".tar.gz") or ($lower | str ends-with ".tgz") {
        system require-cmd tar
        ^tar -xzf $p -C $out_dir
    } else if ($lower | str ends-with ".tar.bz2") or ($lower | str ends-with ".tbz2") {
        system require-cmd tar
        ^tar -xjf $p -C $out_dir
    } else if ($lower | str ends-with ".tar.xz") or ($lower | str ends-with ".txz") {
        system require-cmd tar
        ^tar -xJf $p -C $out_dir
    } else if ($lower | str ends-with ".tar.zst") or ($lower | str ends-with ".tzst") {
        system require-cmd tar
        ^tar --zstd -xf $p -C $out_dir
    } else if ($lower | str ends-with ".tar") {
        system require-cmd tar
        ^tar -xf $p -C $out_dir
    } else if ($lower | str ends-with ".zip") {
        system require-cmd unzip
        ^unzip $p -d $out_dir
    } else if ($lower | str ends-with ".gz") {
        system require-cmd gzip
        ^gzip -dkc $p | save -f ($out_dir | path join ($p | path parse | get stem))
    } else if ($lower | str ends-with ".bz2") {
        system require-cmd bzip2
        ^bzip2 -dkc $p | save -f ($out_dir | path join ($p | path parse | get stem))
    } else if ($lower | str ends-with ".xz") {
        system require-cmd xz
        ^xz -dkc $p | save -f ($out_dir | path join ($p | path parse | get stem))
    } else if ($lower | str ends-with ".zst") {
        system require-cmd zstd
        ^zstd -dkc $p | save -f ($out_dir | path join ($p | path parse | get stem))
    } else if ($lower | str ends-with ".7z") {
        system require-cmd 7z
        ^7z x $"-o($out_dir)" $p
    } else if ($lower | str ends-with ".rar") {
        if ((which unrar | length) > 0) {
            ^unrar x $p $out_dir
        } else {
            system require-cmd 7z
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

# List files including hidden entries with long-format metadata.
#
# Examples:
#   List all files, including hidden ones, in the current directory.
#   > l
#
#   Include symbolic-link targets in the listing.
#   > l --target
export def l [--full-paths, --target(-t), ...paths: string]: nothing -> table {
    let targets = (fs ls-targets ...$paths)

    if $full_paths {
        ls --all --long ...$targets
        | if $target {
            select name type target mode group user size modified
        } else {
            select name type mode group user size modified
        }
    } else {
        ls --all --long --short-names ...$targets
        | if $target {
            select name type target mode group user size modified
        } else {
            select name type mode group user size modified
        }
    }
}

# List files without hidden entries using long-format metadata.
#
# Examples:
#   List visible files in a directory with detailed metadata.
#   > ll ~/.config
#
#   Include symbolic-link targets in the listing.
#   > ll --target /etc
export def ll [--full-paths, --target(-t), ...paths: string]: nothing -> table {
    let targets = (fs ls-targets ...$paths)

    if $full_paths {
        ls --long ...$targets
        | if $target {
            select name type target mode group user size modified
        } else {
            select name type mode group user size modified
        }
    } else {
        ls --long --short-names ...$targets
        | if $target {
            select name type target mode group user size modified
        } else {
            select name type mode group user size modified
        }
    }
}

# Show detailed metadata for a file or directory itself.
#
# Examples:
#   Show detailed info for a file.
#   > path-info ~/.zshrc
#
#   Show a broken symbolic link and its missing target status.
#   > path-info /etc/vconsole.conf
#
#   Show detailed info for a directory instead of its contents.
#   > path-info ~/.config
#
#   Show info for the first selected entry from a listing.
#   > ll | where type == dir | first | path-info
export def path-info [target?: path]: [ nothing -> record, string -> record, record -> record ] {
    let raw = fs path-from-input $target

    if $raw == null {
        error make { msg: "Provide a path as an argument or via pipeline" }
    }

    let p = ($raw | path expand --no-symlink)
    let path_type = ($p | path type)
    if $path_type == null {
        error make { msg: $"path not found: ($p)" }
    }

    let info = (ls --long --directory $p | first)
    if $path_type == symlink {
        let target_exists = ($p | path exists)
        let link_status = if $target_exists {
            "valid"
        } else {
            "broken (target does not exist)"
        }

        $info
        | upsert target_exists $target_exists
        | upsert link_status $link_status
    } else {
        $info
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

    $env._LOADED_ENV_KEYS = (($env | get --optional _LOADED_ENV_KEYS | default [] | append ($vars | get key)) | uniq)
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
