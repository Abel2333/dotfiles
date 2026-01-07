# Alias
alias ll="ls -l --color"
alias l="ls -al --color"
alias ls="ls --color"
alias lfub="${HOME}/.config/lf/lfub"
alias k="kitty +kitten"
alias v="nvim"
alias ac="aria2c -c -x 8 -s 8 -d ${HOME}/Downloads"

# Start `yazi` and change current working direcotry with `q`
# `Q` to not change
function y() {
  local tmp="$(mktemp -t "yazi-cwd.XXXXXX")" cwd
  yazi "$@" --cwd-file="$tmp"
  IFS= read -r -d '' cwd < "$tmp"
  [ -n "$cwd" ] && [ "$cwd" != "$PWD" ] && builtin cd -- "$cwd"
  rm -f -- "$tmp"
}

function extract() {
  if [ -f "$1" ]; then
    case "$1" in
      *.tar.bz2)    tar xjf "$1" ;;
      *.tar.gz)     tar xzf "$1" ;;
      *.bz2)        bunzip2 "$1" ;;
      *.rar)        unrar x "$1" ;;
      *.gz)         gunzip "$1" ;;
      *.tar)        tar xf "$1" ;;
      *.tbz2)       tar xjf "$1" ;;
      *.tgz)        tar xzf "$1" ;;
      *.zip)        unzip "$1" ;;
      *.7z)         7z x "$1" ;;
      *)            echo "Unsupported format: $1" ;;
    esac
  else
    echo "File not found: $1"
  fi
}
