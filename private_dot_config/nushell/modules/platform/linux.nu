# Linux-specific environment customizations.

use $"($nu.default-config-dir)/lib/path.nu" prepend-paths

prepend-paths [
    "/usr/lib64/qt6/bin",
    "/usr/local/cuda-13.0/bin",
]

# Restore or start a dedicated ssh-agent, cached in the temp directory.
def --env ssh-agent-from-cache [] {
    let ssh_agent_file = (
        $nu.temp-dir | path join $"ssh-agent-(whoami).nuon"
    )

    if ($ssh_agent_file | path exists) {
        let ssh_agent_env = (try { open $ssh_agent_file } catch { null })
        let ssh_agent_pid = if $ssh_agent_env == null {
            null
        } else {
            $ssh_agent_env | get --optional SSH_AGENT_PID
        }

        if ($ssh_agent_pid != null) and ($"/proc/($ssh_agent_pid)" | path exists) {
            load-env $ssh_agent_env
            return
        } else {
            rm --force $ssh_agent_file
        }
    }

    let ssh_agent_env = ^ssh-agent -c
        | lines
        | first 2
        | parse "setenv {name} {value};"
        | transpose --header-row
        | into record

    load-env $ssh_agent_env
    $ssh_agent_env | save --force $ssh_agent_file
}

$env.GPG_TTY = (^tty | str trim)

# Prefer the GnuPG SSH agent when it exposes its socket; fall back to a
# dedicated ssh-agent otherwise.
#
# The ssh socket is only created while a gpg-agent with `enable-ssh-support`
# is actually running, so checking the socket file is more accurate than
# checking for the `gpg` binary: gpgconf reports the configured path even
# when no agent is up. A missing socket is expected whenever the agent has
# not started yet (e.g. the first shell after boot) or ssh support is
# disabled, and the fallback keeps SSH working in those shells.
let gpg_ssh_socket = (try { ^gpgconf --list-dirs agent-ssh-socket | str trim } catch { "" })
if ($gpg_ssh_socket != "") and ($gpg_ssh_socket | path exists) {
    $env.SSH_AUTH_SOCK = $gpg_ssh_socket
} else {
    ssh-agent-from-cache
}
^gpg-connect-agent updatestartuptty /bye o+e>| ignore

$env.LFS = "/mnt/lfs"
