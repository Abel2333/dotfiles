-- [[ Setting options ]]
-- See `:help vim.opt'
-- For more options, see `:help option-list'

-- Add the line numbers and relative line numbers
-- for conveniently jumping
vim.opt.number = true
vim.opt.relativenumber = true

-- Enable mouse, can be useful for resizing splits.
vim.opt.mouse = 'a'

-- Do not show the mode, since it is already in the status line
vim.opt.showmode = false

-- Enable true color
vim.opt.termguicolors = true

-- If using Neovim under SSH, using OSC52 to synchronous system clipboard.
vim.opt.clipboard:append 'unnamedplus'
if vim.fn.exists '$SSH_TTY' == 1 and vim.env.TMUX == nil then
    vim.g.clipboard = {
        name = 'OSC 52',
        copy = {
            ['+'] = require('vim.ui.clipboard.osc52').copy '+',
            ['*'] = require('vim.ui.clipboard.osc52').copy '*',
        },
        paste = {
            ['+'] = require('vim.ui.clipboard.osc52').paste '+',
            ['*'] = require('vim.ui.clipboard.osc52').paste '*',
        },
    }
end

-- Enable break indent
vim.opt.breakindent = true

-- Save undo history
vim.opt.undofile = true

-- Update window title
vim.opt.title = true

-- Case-insensitive searching UNLESS \C or one or more capital
-- letters in the search term
vim.opt.ignorecase = true
vim.opt.smartcase = true

-- Keep signcolumn on by default
vim.opt.signcolumn = 'yes'

-- Show a virtual column for suggest length
vim.opt.colorcolumn = '101'

-- Decrease update time
vim.opt.updatetime = 250

-- Decrease mapped sequence wait time
-- Displays which-key popup sooner
vim.opt.timeoutlen = 300

-- Configure how new splits should be opened
vim.opt.splitright = true
vim.opt.splitbelow = true

-- Sets how neovim will display certain whitespace characters in the editor
vim.opt.list = true
vim.opt.listchars = { tab = '» ', trail = '·', nbsp = '␣' }

-- Preview substitutions live, as you type!
vim.opt.inccommand = 'split'

-- Show which line your cursor is on
vim.opt.cursorline = true

-- Minimal number of screen lines to keep above and below the cursor.
vim.opt.scrolloff = 10

-- Set indentation
vim.opt.tabstop = 4
vim.opt.shiftwidth = 4
vim.opt.autoindent = true
vim.opt.expandtab = true

-- Completions
vim.opt.completeopt = { 'menu', 'menuone', 'noinsert' }

vim.opt.fillchars = {
    eob = ' ',
    diff = '╱',
    foldopen = '',
    foldclose = '',
    foldsep = '▕',
}
