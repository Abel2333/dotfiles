use ~/.config/nushell/lib/commandline.nu
use ~/.config/nushell/lib/fs.nu
use ~/.config/nushell/lib/history.nu
use ~/.config/nushell/lib/system.nu
use ~/.config/nushell/lib/ui.nu

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
export def l [--full-paths, ...paths: string]: nothing -> table {
    let targets = (fs ls-targets ...$paths)
    let color_base = if ($targets | length) == 1 { $targets | first } else { null }

    if $full_paths {
        ls --all --long ...$targets
        | select name type mode group user size modified
    } else {
        ls --all --long --short-names ...$targets
        | select name type target mode group user size modified
        | fs ls-colorize-name $color_base
        | reject target
    }
}

# List files without hidden entries using long-format metadata.
#
# Examples:
#   List visible files in a directory with detailed metadata.
#   > ll ~/.config
export def ll [--full-paths, ...paths: string]: nothing -> table {
    let targets = (fs ls-targets ...$paths)
    let color_base = if ($targets | length) == 1 { $targets | first } else { null }

    if $full_paths {
        ls --long ...$targets
        | select name type mode group user size modified
    } else {
        ls --long --short-names ...$targets
        | select name type target mode group user size modified
        | fs ls-colorize-name $color_base
        | reject target
    }
}

# Show detailed metadata for a file or directory itself.
#
# Examples:
#   Show detailed info for a file.
#   > path-info ~/.zshrc
#
#   Show detailed info for a directory instead of its contents.
#   > path-info ~/.config
#
#   Show info for the first selected entry from a listing.
#   > ll | where type == dir | first | path-info
export def path-info [target?: path]: [ nothing -> record, string -> record, record -> record ] {
    let raw = if $target != null {
        $target
    } else if (($in | describe) | str starts-with "record") {
        $in.name
    } else {
        $in
    }

    if $raw == null {
        error make { msg: "Provide a path as an argument or via pipeline" }
    }

    let p = ($raw | path expand)
    if not ($p | path exists) {
        error make { msg: $"path not found: ($p)" }
    }

    ls --long --directory $p | first
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

# Fuzzy-pick a directory under the current working tree and `cd` into it.
#
# Examples:
#   Open `fzf` with directories (including hidden ones except `.git`) and jump
#   to the selected directory.
#   > fzf-cd
export def --env fzf-cd [] {
    let dir = (fd --type d --hidden --exclude .git | to text | fzf --height 100% --border | str trim)
    if ($dir | is-not-empty) { cd $dir }
}

export def --env fzf-history [] {
    let query = (commandline)
    commandline edit --replace ""
    print -n $'(ansi --escape "2K")\r'
    let nul = (char --integer 0)
    let sep = (char tab)
    let history_state = (history fzf-rows)
    let has_timestamps = $history_state.has_timestamps
    let entry_state = (history fzf-entries $history_state.rows $has_timestamps)
    let entries = $entry_state.entries

    let selected = (
        $entries
        | each { |row| $row.display }
        | str join $nul
        | fzf
            --read0
            --height 40%
            --min-height 20+
            --scheme history
            --bind 'ctrl-r:toggle-sort'
            --highlight-line
            --wrap
            --wrap-sign $entry_state.wrap_sign
            --ansi
            --tabstop 1
            --query $query
            --delimiter $sep
            --nth $entry_state.nth
            +m
        | str trim
    )
    let command = (history selected-command $selected $query $entries $has_timestamps)

    commandline edit --replace $command
}

# Fuzzy-pick a file or directory and insert its path into the current command line.
#
# Examples:
#   Open `fzf` with project entries and insert the selected path at the cursor.
#   > fzf-file-insert
export def --env fzf-file-insert [] {
    let line = (commandline state)
    let left = $line.left
    let right = $line.right
    let selected_raw = (
        fd --hidden --exclude .git
        | to text
        | fzf --height 100% --border
        | str trim
    )

    if ($selected_raw | is-not-empty) {
        let selected = if ($selected_raw =~ '^[[:alnum:]_./~-]+$') {
            $selected_raw
        } else {
            $selected_raw | to nuon
        }
        let spacer = if (($left | is-empty) or ($left | str ends-with " ")) {
            ""
        } else {
            " "
        }
        let next = $"($left)($spacer)($selected)($right)"
        commandline edit --replace $next
        commandline set-cursor (($left | str length) + ($spacer | str length) + ($selected | str length))
    }
}

# Search project contents with ripgrep, filter matches in `fzf`, and open the
# selected result in Neovim at the matching line.
#
# Examples:
#   Search for `prompt` in the current project and jump to the selected match.
#   > rg-fzf prompt
export def rg-fzf [
    pattern?: string
]: nothing -> nothing {
    system require-cmd rg
    system require-cmd fzf

    let query = if $pattern == null { "" } else { $pattern }
    let editor = (system editor-command)
    let sep = (char --integer 31)
    let preview = "sh -c 'line=$2; start=$(( line > 3 ? line - 3 : 1 )); end=$(( line + 3 )); sed -n \"${start},${end}p\" \"$1\"' _ {1} {2}"
    let selected = (
        ^rg --json --color=never --smart-case $query
        | from json --objects
        | where { |row| $row.type == "match" }
        | each { |row|
            let file = $row.data.path.text
            let line = ($row.data.line_number | into string)
            let text = (
                $row.data.lines.text
                | str trim
                | str replace --all "\t" " "
            )
            let display = $"($file):($line): ($text)"
            [$file, $line, $display] | str join $sep
        }
        | to text
        | fzf --height 100% --border --ansi --query $query --delimiter $sep --with-nth 3 --preview $preview
        | str trim
    )

    if ($selected | is-empty) {
        return
    }

    let parts = ($selected | split row $sep --number 3)
    let file = ($parts | get 0)
    let line = ($parts | get 1)
    run-external ...$editor $"+($line)" $file
}
