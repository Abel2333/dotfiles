# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# Install zinit
ZINIT_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}/zinit/zinit.git"
[ ! -d $ZINIT_HOME ] && mkdir -p "$(dirname $ZINIT_HOME)"
[ ! -d $ZINIT_HOME/.git ] && git clone https://github.com/zdharma-continuum/zinit.git "$ZINIT_HOME"
source "${ZINIT_HOME}/zinit.zsh"

# Install powerlevel10k
zinit ice depth=1; zinit light romkatv/powerlevel10k


# The following lines were added by compinstall

zstyle ':completion:*' completer _expand _complete _ignored _correct _approximate
zstyle ':completion:*' file-sort name
zstyle ':completion:*' group-name ''
zstyle ':completion:*' insert-unambiguous true
zstyle ':completion:*' list-colors ''
zstyle ':completion:*' list-prompt %SAt %p: Hit TAB for more, or the character to insert%s
zstyle ':completion:*' matcher-list 'm:{[:lower:][:upper:]}={[:upper:][:lower:]}' 'r:|[._-]=** r:|=**' 'l:|=* r:|=*'
zstyle ':completion:*' menu select=1
zstyle ':completion:*' select-prompt %SScrolling active: current selection at %p%s
zstyle ':completion:*' verbose true
zstyle :compinstall filename '/home/abel/.zshrc'

autoload -Uz compinit
compinit
# End of lines added by compinstall
# Lines configured by zsh-newuser-install
HISTFILE=~/.histfile
HISTSIZE=1000
SAVEHIST=1000
setopt nomatch
unsetopt autocd extendedglob
bindkey -v
setopt INC_APPEND_HISTORY       # 每条命令执行后立即追加到文件
setopt SHARE_HISTORY            # 多个 shell 实时共享历史
setopt HIST_IGNORE_DUPS         # 忽略重复命令
setopt HIST_IGNORE_SPACE        # 忽略以空格开头的命令
setopt HIST_SAVE_NO_DUPS        # 不保存重复命令

# Alias
alias ll="ls -l --color"
alias ls="ls --color"
alias lfub="${HOME}/.config/lf/lfub"
alias k="kitty +kitten"
alias v="nvim"
alias ac="aria2c -c -x 8 -s 8 -d ${HOME}/Downloads"

# Environment variable
source $HOME/.zshenv

# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# Plugins
# eval "$(atuin init zsh)"
eval "$(zoxide init zsh)"
eval "$(gh copilot alias -- zsh)"

# Set up fzf key bindings and fuzzy completion
source <(fzf --zsh)

# Added by LM Studio CLI (lms)
export PATH="$PATH:/home/abel/.lmstudio/bin"
# End of LM Studio CLI section
