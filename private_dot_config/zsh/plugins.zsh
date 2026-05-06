# Install zinit manually 
ZINIT_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}/zinit/zinit.git"
[ ! -d $ZINIT_HOME ] && mkdir -p "$(dirname $ZINIT_HOME)"
[ ! -d $ZINIT_HOME/.git ] && git clone https://github.com/zdharma-continuum/zinit.git "$ZINIT_HOME"
source "${ZINIT_HOME}/zinit.zsh"

# Zinit plugins
## zsh-autosuggestions
zinit ice depth=1; zinit light zsh-users/zsh-autosuggestions
## zsh-completions
zinit light zsh-users/zsh-completions

# Other Plugins
# eval "$(atuin init zsh)"
eval "$(zoxide init zsh)"
# eval "$(gh copilot alias -- zsh)"
eval "$(starship init zsh)"

source <(fzf --zsh)
