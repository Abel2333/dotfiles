# env.nu
#
# Installed by:
# version = "0.112.2"
#
# Previously, environment variables were typically configured in `env.nu`.
# In general, most configuration can and should be performed in `config.nu`
# or one of the autoload directories.
#
# This file is generated for backwards compatibility for now.
# It is loaded before config.nu and login.nu
#
# See https://www.nushell.sh/book/configuration.html
#
# Also see `help config env` for more options.
#
# You can remove these comments if you want or leave
# them for future reference.

##########
#  Path  #
##########
$env.GOBIN = $"($env.HOME)/.local/bin"
$env.PATH = ($env.PATH | prepend [
    $"($env.HOME)/.local/bin",
    "/usr/lib64/qt6/bin",
    $"($env.HOME)/.cargo/bin"
])
$env.PATH = ($env.PATH | prepend "/usr/local/cuda-13.0/bin")
$env.PATH = ($env.PATH | prepend $"($env.HOME)/.dotnet")

############
#  Zoxide  #
############
zoxide init nushell | save -f $"($env.HOME)/.zoxide.nu"

############
#  Editor  #
############
$env.EDITOR = 'nvim'
$env.VISUAL = 'nvim'

############
#  Locale  #
############
$env.LANG = 'en_US.UTF-8'
$env.LC_CTYPE = 'zh_CN.UTF-8'
$env.LC_TIME = 'C.UTF-8'

#############
#  OpenGPG  #
#############
$env.GPG_TTY = (^tty | str trim)
$env.SSH_AUTH_SOCK = (^gpgconf --list-dirs agent-ssh-socket | str trim)
^gpg-connect-agent updatestartuptty /bye o+e>| ignore

#########
#  LFS  #
#########
$env.LFS = '/mnt/lfs'

##########
#  PNPM  #
##########
$env.PNPM_HOME = $"($env.HOME)/.local/share/pnpm"
# Add only once, avoid duplication
if not ($env.PATH | any {|p| $p == $env.PNPM_HOME}) {
    $env.PATH = ($env.PATH | prepend $env.PNPM_HOME)
}

##############
#  Carapace  #
##############
$env.CARAPACE_BRIDGES = 'zsh,fish,bash,inshellisense' # optional
mkdir $"($nu.cache-dir)"
carapace _carapace nushell | save --force $"($nu.cache-dir)/carapace.nu"

#############
#  Secrets  #
#############
source ~/.config/nushell/secrets.nu
