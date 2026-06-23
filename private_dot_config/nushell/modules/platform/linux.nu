# Linux-specific environment customizations.

use $"($nu.default-config-dir)/lib/path.nu" prepend-paths

prepend-paths [
    "/usr/lib64/qt6/bin",
    "/usr/local/cuda-13.0/bin",
]

do --env {
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
$env.SSH_AUTH_SOCK = (^gpgconf --list-dirs agent-ssh-socket | str trim)
^gpg-connect-agent updatestartuptty /bye o+e>| ignore

$env.LFS = "/mnt/lfs"
