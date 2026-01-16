# Path
export PATH="$HOME/.local/bin:/usr/lib64/qt6/bin:$HOME/.cargo/bin:$PATH"
export PATH=/usr/local/cuda-13.0/bin:$PATH
export OLLAMA_MODELS="$HOME/Public/Model/Ollama"
export EDITOR="nvim"
export VISUAL="nvim"

# Let Charset support Chinese
export LANG=en_US.UTF-8
export LC_CTYPE=zh_CN.UTF-8
export LC_TIME=C.UTF-8

# OpenGPG
export GPG_TTY=$(tty)
export SSH_AUTH_SOCK=$(gpgconf --list-dirs agent-ssh-socket)
gpg-connect-agent updatestartuptty /bye > /dev/null

# LFS
export LFS=/mnt/lfs

# Use NVM
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

# Use pnpm
export PNPM_HOME="/home/abel/.local/share/pnpm"
case ":$PATH:" in
  *":$PNPM_HOME:"*) ;;
  *) export PATH="$PNPM_HOME:$PATH" ;;
esac
