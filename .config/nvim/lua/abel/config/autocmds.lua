-- [[ Autocmd settings ]]
-- autocmd is using to execute the specified function
-- automatically after the event is triggered

local number_group = vim.api.nvim_create_augroup('toggle-line-number', { clear = true })
local indent_group = vim.api.nvim_create_augroup('toggle-indent', {})

-- Highlight when yanking (copying) text
vim.api.nvim_create_autocmd('TextYankPost', {
    desc = 'Highlight when yanking (copying) text',
    group = vim.api.nvim_create_augroup('highlight-yank', { clear = true }),
    callback = function()
        vim.highlight.on_yank()
    end,
})

-- Show the Absolute line number when enter
-- the Insert mode.

vim.api.nvim_create_autocmd({ 'InsertEnter' }, {
    desc = 'Disable the relative line number when enter insert mode',
    group = number_group,
    callback = function()
        vim.opt.relativenumber = false
    end,
})

vim.api.nvim_create_autocmd({ 'InsertLeave' }, {
    desc = 'Enable relative line number when leave insert mode',
    group = number_group,
    callback = function()
        vim.opt.relativenumber = true
    end,
})

vim.api.nvim_create_autocmd('FileType', {
    group = indent_group,
    pattern = 'yaml',
    desc = 'Set indent for yaml',
    callback = function()
        vim.bo.tabstop = 4
        vim.bo.shiftwidth = 4
        vim.bo.expandtab = false
    end,
})
