-- [[ Autocmd settings ]]
-- autocmd is using to execute the specified function
-- automatically after the event is triggered

local number_group = vim.api.nvim_create_augroup('toggle-line-number', { clear = true })
local indent_group = vim.api.nvim_create_augroup('toggle-indent', { clear = true })
local check_group = vim.api.nvim_create_augroup('check status', { clear = true })

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
        local buftype = vim.bo.buftype
        if buftype == '' then
            vim.opt.relativenumber = false
        end
    end,
})

vim.api.nvim_create_autocmd({ 'InsertLeave' }, {
    desc = 'Enable relative line number when leave insert mode',
    group = number_group,
    callback = function()
        local buftype = vim.bo.buftype
        if buftype == '' then
            vim.opt.relativenumber = true
        end
    end,
})

-- Specific files
vim.api.nvim_create_autocmd('FileType', {
    group = indent_group,
    pattern = 'yaml',
    desc = 'Set indent for yaml',
    callback = function()
        local bufnr = vim.api.nvim_get_current_buf()
        vim.bo[bufnr].tabstop = 4
        vim.bo[bufnr].shiftwidth = 4
        vim.bo[bufnr].expandtab = false
    end,
})

vim.api.nvim_create_autocmd({
    'FocusGained',
    'BufEnter',
    'CursorHold',
}, {
    group = check_group,
    desc = 'Reload buffer on focus',
    callback = function()
        if vim.fn.getcmdwintype() == '' then
            vim.cmd 'checktime'
        end
    end,
})
