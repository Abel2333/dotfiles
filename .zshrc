# Enable Powerlevel10k instant prompt. Should stay close to the top of ~/.zshrc.
# Initialization code that may require console input (password prompts, [y/n]
# confirmations, etc.) must go above this block; everything else may go below.
if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi


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

# Alias
alias ll="ls -l --color"
alias ls="ls --color"
alias lfub="${HOME}/.config/lf/lfub"
alias k="kitty +kitten"
alias v="nvim"

# Environment variable
export XCURSOR_PATH=${XCURSOR_PATH}:~/.local/share/icons
# export XCURSOR_THEME='Bibata-Modern-Classic'
# export XCURSOR_SIZE=24
export RANGER_LOAD_DEFAULT_RC=false
export EDITOR=nvim
export SUDO_EDITOR=/usr/bin/nvim
## For lua require
export LUA_PATH='/usr/share/lua/5.1/?.lua;./?.lua;/usr/share/lua/5.1/?/init.lua;/usr/lib64/lua/5.1/?.lua;/usr/lib64/lua/5.1/?/init.lua;/home/abel/.luarocks/share/lua/5.1/?.lua;/home/abel/.luarocks/share/lua/5.1/?/init.lua;/usr/share/lua/5.1/share/lua/5.1/?.lua;/usr/share/lua/5.1/share/lua/5.1/?/init.lua'
export LUA_CPATH='./?.so;/usr/lib64/lua/5.1/?.so;/usr/lib64/lua/5.1/loadall.so;/home/abel/.luarocks/lib/lua/5.1/?.so;/usr/share/lua/5.1/lib/lua/5.1/?.so'
export PATH='/home/abel/.luarocks/bin:/usr/share/lua/5.1/bin:/home/abel/miniconda3/bin:/home/abel/miniconda3/condabin:/usr/local/sbin:/usr/local/bin:/usr/bin:/opt/bin:/usr/lib/llvm/17/bin:/etc/eselect/wine/bin'

## For fzf
export FZF_DEFAULT_COMMAND='fd --type f'

# End of lines configured by zsh-newuser-install
source "/usr/share/zsh/site-functions/powerlevel10k/powerlevel10k.zsh-theme"

# To customize prompt, run `p10k configure` or edit ~/.p10k.zsh.
[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# Plugins
eval "$(atuin init zsh)"

# >>> conda initialize >>>
# !! Contents within this block are managed by 'conda init' !!
__conda_setup="$('/home/abel/miniconda3/bin/conda' 'shell.zsh' 'hook' 2> /dev/null)"
if [ $? -eq 0 ]; then
    eval "$__conda_setup"
else
    if [ -f "/home/abel/miniconda3/etc/profile.d/conda.sh" ]; then
        . "/home/abel/miniconda3/etc/profile.d/conda.sh"
    else
        export PATH="/home/abel/miniconda3/bin:$PATH"
    fi
fi
unset __conda_setup
# <<< conda initialize <<<

# Set up fzf key bindings and fuzzy completion
source <(fzf --zsh)
