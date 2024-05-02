-- [[ Install `lazy.nvim' plugin manager ]]
-- See `:help lazy.nvim.txt' or https://github.com/folke/lazy.nvim
-- for more info.

local lazypath = vim.fn.stdpath 'data' .. '/lazy/lazy.nvim'
if not (vim.uv or vim.loop).fs_stat(lazypath) then
    vim.fn.system {
        'git',
        'clone',
        '--filter=blob:none',
        'https://github.com/folke/lazy.nvim.git',
        '--branch=stable', -- latest stable release
        lazypath,
    }
end
vim.opt.rtp:prepend(lazypath)

-- vim: ts=4 sts=4 sw=4 et
