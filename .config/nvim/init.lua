-- This configuration is begin from kickstart object
-- in `https://github.com/nvim-lua/kickstart.nvim'

-- Set <space> as the leader key
vim.g.mapleader = ' '
vim.g.maplocalleader = ' '

-- [[Setting options]]
require 'options'

-- [[Setting keymaps]]
require 'keymaps'

-- [[ Install `lazy.nvim' plugin manager ]]
require 'lazy-bootstrap'

-- [[ Configure and install plugins ]]
require 'lazy-plugins'

-- The line beneath this is called `modeline`. See `:help modeline'
-- vim: ts=4 sts=4 sw=4 et
