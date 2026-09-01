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

# Warm up gpg-agent by unlocking the signing key, so later signed
# operations (e.g. git commit) do not trigger a pinentry prompt.
# Run this in your own terminal: pinentry needs direct TTY access.
#
# Examples:
#   Unlock the key configured in git user.signingkey.
#   > gpg-warmup
#
#   Only check whether the passphrase is already cached.
#   > gpg-warmup --check
#
#   Warm up a specific key instead of the git signing key.
#   > gpg-warmup --key AB11547CE665126A
export def gpg-warmup [--key(-k): string, --check(-c)]: nothing -> nothing {
    let key = if $key != null {
        $key
    } else {
        (do -i { ^git config --get user.signingkey } | complete | get stdout | str trim)
    }
    let key_args = if ($key | is-empty) { [] } else { [--local-user $key] }
    let label = if ($key | is-empty) { "default key" } else { $key }

    # Probe: --pinentry-mode error makes this fail instead of prompting
    # when the passphrase is not yet cached by the agent.
    let probe = ("warmup-probe" | ^gpg --batch --yes --quiet --pinentry-mode error --clearsign ...$key_args --output /dev/null | complete)
    if $probe.exit_code == 0 {
        print $"gpg-agent already has a cached passphrase for ($label)"
        return
    }
    if $check {
        print $"No cached passphrase for ($label)"
        return
    }

    print $"Unlocking ($label) - pinentry may prompt for the passphrase..."
    "warmup" | ^gpg --yes --quiet --clearsign ...$key_args --output /dev/null
    if ($env.LAST_EXIT_CODE != 0) {
        error make { msg: $"gpg-warmup failed for ($label)" }
    }

    # Verify the agent now serves the key without prompting.
    let verify = ("warmup-verify" | ^gpg --batch --yes --quiet --pinentry-mode error --clearsign ...$key_args --output /dev/null | complete)
    if $verify.exit_code == 0 {
        print $"gpg-agent warmed up for ($label); signed commits should not prompt until the cache TTL expires"
    } else {
        error make { msg: $"Unlock succeeded but ($label) is still not served from cache" }
    }
}

# Parse `ssh-add -l` output into a table of identities.
def parse-ssh-identities []: string -> table {
    lines | parse --regex '^(?<bits>\d+) (?<fingerprint>\S+) (?<comment>.*) \((?<type>[^()]+)\)$'
}

# Shared core: warm the agent cache entry for a served SSH key by
# signing a dummy file locally through the agent protocol. The agent
# performs the private key operation itself and prompts via pinentry
# once; the passphrase is then cached under the key's keygrip.
def ssh-agent-warm [pubkey: string, keygrip: string, label: string, check: bool]: nothing -> nothing {
    # Cache probe: keyinfo reports per-keygrip state; field index 6 is
    # '1' when the passphrase is cached, '-' otherwise. Pure agent
    # query - never triggers pinentry.
    let probe = {^gpg-connect-agent 'keyinfo --list' /bye | complete | get stdout | lines | each {|l| $l | split row ' ' } | where {|f| ($f | get --optional 1 | default "") == "KEYINFO" and ($f | get --optional 2 | default "") == $keygrip } | get --optional 0 | default [] | get --optional 6 | default "" }

    if (do $probe) == "1" {
        print $"gpg-agent already has a cached passphrase for ($label)"
        return
    }
    if $check {
        print $"No cached passphrase for ($label)"
        return
    }

    # Warm: ssh-keygen resolves the public key via the agent and asks
    # it to sign; the agent prompts via pinentry if not yet cached.
    let tmp = (mktemp --tmpdir ssh-warmup.XXXXXX)
    $pubkey + "\n" | save --force $"($tmp).pub"
    "warmup" | save --force $tmp
    print $"Unlocking ($label) - pinentry may prompt for the passphrase..."
    ^ssh-keygen -Y sign -f $"($tmp).pub" -n ssh-warmup $tmp
    let rc = $env.LAST_EXIT_CODE
    rm --force $tmp $"($tmp).pub" $"($tmp).sig"
    if $rc != 0 {
        error make { msg: $"ssh-warmup failed for ($label)" }
    }

    # Verify the passphrase is now served from cache.
    if (do $probe) == "1" {
        print $"gpg-agent warmed up for ($label); SSH connections should not prompt until the cache TTL expires"
    } else {
        error make { msg: $"Unlock succeeded but ($label) is still not served from cache" }
    }
}

# Warm up the gpg-agent passphrase cache for the [A] (authentication)
# subkey of the git signing key, which gpg-agent exposes as an SSH
# identity. Signing a dummy file through the SSH agent protocol unlocks
# the same per-keygrip cache entry a real SSH push uses, so no server
# connection is needed.
def ssh-warmup-gpg [check: bool]: nothing -> nothing {
    let gkey = (do -i { ^git config --get user.signingkey } | complete | get stdout | str trim)
    if ($gkey | is-empty) {
        error make { msg: "git user.signingkey is not set; cannot locate the GPG key" }
    }

    # Find the keygrip of the [A] subkey: in --with-colons output the
    # sub record carries key capabilities at index 11 ('a' = auth) and
    # the grp record right after it carries the keygrip at index 9.
    let records = (^gpg --list-keys --with-colons --with-keygrip $gkey | complete | get stdout | lines | each {|l| $l | split row ':' })
    let auth_idx = ($records | enumerate | where {|r| ($r.item | get --optional 0 | default "") == "sub" and (($r.item | get --optional 11 | default "") | str contains "a") } | get --optional 0.index)
    if $auth_idx == null {
        error make { msg: $"GPG key ($gkey) has no [A] authentication subkey" }
    }
    let keygrip = ($records | skip ($auth_idx + 1) | where {|r| ($r | get --optional 0 | default "") == "grp" } | get --optional 0 | default [] | get --optional 9)
    if $keygrip == null {
        error make { msg: $"Cannot determine the keygrip of the [A] subkey of ($gkey)" }
    }

    # gpg-agent only serves SSH keys whose keygrip is whitelisted in
    # ~/.gnupg/sshcontrol. Verify the key is served before anything
    # else, otherwise the agent lookup fails with a cryptic error.
    let ssh_pubkey = (^gpg --export-ssh-key $gkey | complete | get stdout | str trim)
    let blob = ($ssh_pubkey | split row ' ' | get --optional 1 | default "")
    let served = ($blob != "") and ((^ssh-add -L | complete | get stdout) | str contains $blob)
    if not $served {
        error make { msg: $"gpg-agent does not serve the [A] subkey of ($gkey) over SSH.\nAdd this line to ~/.gnupg/sshcontrol, then retry:\n\n    ($keygrip) 3600\n" }
    }

    ssh-agent-warm $ssh_pubkey $keygrip $"[A] subkey of ($gkey)" $check
}

# Warm up an agent-served SSH key selected by its SSH fingerprint (as
# shown by `ssh-add -l`), without needing the key file path.
def ssh-warmup-fp [fingerprint: string, check: bool]: nothing -> nothing {
    let target = ($fingerprint | str replace --regex '^SHA256:' '')

    # The key must actually be served over the SSH protocol...
    let listed = (^ssh-add -l | complete)
    if $listed.exit_code != 0 {
        error make { msg: "The agent serves no SSH identities (ssh-add -l is empty)" }
    }
    if not ($listed.stdout | str contains $target) {
        error make { msg: $"The agent does not serve a key with fingerprint ($fingerprint)" }
    }

    # ...and mappable to a keygrip for cache probing.
    let keygrip = (^gpg-connect-agent 'keyinfo --list --ssh-fpr' /bye | complete | get stdout | lines | each {|l| $l | split row ' ' } | where {|f| ($f | get --optional 1 | default "") == "KEYINFO" and (($f | get --optional 8 | default "") | str contains $target) } | get --optional 0 | default [] | get --optional 2)
    if $keygrip == null {
        error make { msg: $"Cannot map fingerprint ($fingerprint) to an agent keygrip" }
    }

    # Public key line for the local sign, matched by fingerprint.
    let pubkey = (^ssh-add -L | complete | get stdout | lines | where {|pk| (($pk | ^ssh-keygen -lf /dev/stdin | complete | get stdout) | str contains $target) } | get --optional 0)
    if $pubkey == null {
        error make { msg: $"Cannot read the public key for ($fingerprint) from the agent" }
    }

    ssh-agent-warm $pubkey $keygrip $"key ($fingerprint)" $check
}

# Warm up SSH authentication so git fetch/push over SSH does not
# prompt for a passphrase. Key sources: plain key files (loaded via
# ssh-add), the GPG [A] authentication subkey of the git signing key
# (--gpg), or any key already served by the agent (--fingerprint).
# Run this in your own terminal: pinentry needs direct TTY access.
# Complements gpg-warmup, which covers commit signing.
#
# Examples:
#   Load the default keys (~/.ssh/id_ed25519, ...) into the agent.
#   > ssh-warmup
#
#   List the identities currently loaded in the agent.
#   > ssh-warmup --check
#
#   Load a specific key instead of the defaults.
#   > ssh-warmup --key ~/.ssh/id_ed25519_work
#
#   Warm up the GPG [A] subkey (of git user.signingkey) instead,
#   without connecting to any server.
#   > ssh-warmup --gpg
#
#   Warm up a key already served by the agent, selected by its SSH
#   fingerprint (see `ssh-warmup --check`), without any file path.
#   > ssh-warmup --fingerprint SHA256:cfwEjafvbwaRVGWiv2qF5lVPvSAPf/wh27yRpaA0qso
export def ssh-warmup [--key(-k): path, --check(-c), --gpg(-g), --fingerprint(-f): string]: [ nothing -> nothing, nothing -> table ] {
    let modes = ([($key != null) $gpg ($fingerprint != null)] | where {|m| $m } | length)
    if $modes > 1 {
        error make { msg: "--key, --gpg and --fingerprint are mutually exclusive" }
    }
    if $gpg {
        return (ssh-warmup-gpg $check)
    }
    if $fingerprint != null {
        return (ssh-warmup-fp $fingerprint $check)
    }
    # Probe: ssh-add -l exits 0 with identities, 1 with none, 2 when the
    # agent is unreachable. Listing never triggers a passphrase prompt.
    let list = (^ssh-add -l | complete)
    if $list.exit_code == 2 {
        error make { msg: "Cannot connect to the ssh agent (is SSH_AUTH_SOCK set?)" }
    }

    # Fingerprint of the requested key, to test whether that specific
    # key is already served by the agent. Reads only the public part.
    let target_fp = if $key != null {
        let fp = (^ssh-keygen -lf ($key | path expand) | complete)
        if $fp.exit_code != 0 {
            error make { msg: $"Cannot read key: ($key)" }
        }
        ($fp.stdout | str trim | split row ' ' | get 1)
    } else { null }

    let already = if $target_fp != null {
        ($list.stdout | str contains $target_fp)
    } else {
        $list.exit_code == 0
    }

    if $already {
        if $key != null {
            print $"ssh-agent already has ($key) loaded"
            return
        }
        print $"ssh-agent already has ($list.stdout | lines | length) identities loaded:"
        return ($list.stdout | parse-ssh-identities)
    }
    if $check {
        if $key != null {
            print $"Key not loaded in ssh-agent: ($key)"
        } else {
            print "No identities loaded in the ssh-agent"
        }
        return
    }

    let label = if $key != null { $key } else { "default keys" }
    print $"Loading ($label) - pinentry may prompt for the passphrase..."
    if $key != null {
        ^ssh-add ($key | path expand)
    } else {
        ^ssh-add
    }
    if ($env.LAST_EXIT_CODE != 0) {
        error make { msg: $"ssh-warmup failed for ($label)" }
    }

    # Verify the agent now serves the key.
    let verify = (^ssh-add -l | complete)
    let ok = if $target_fp != null {
        ($verify.stdout | str contains $target_fp)
    } else {
        $verify.exit_code == 0
    }
    if $ok {
        print $"ssh-agent warmed up for ($label); SSH connections should not prompt until the cache TTL expires"
        if $key == null {
            return ($verify.stdout | parse-ssh-identities)
        }
    } else {
        error make { msg: $"ssh-add succeeded but ($label) is still not served by the agent" }
    }
}
