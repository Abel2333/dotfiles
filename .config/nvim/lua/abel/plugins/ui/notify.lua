---@type LazyPluginSpec
return {
    'rcarriga/nvim-notify',
    event = 'VeryLazy',
    opts = {
        stages = 'static',
        timeout = 3000,
        max_height = function()
            return math.floor(vim.o.lines * 0.75)
        end,
        max_width = function()
            return math.floor(vim.o.columns * 0.75)
        end,
        on_open = function(win)
            vim.api.nvim_win_set_config(win, { zindex = 100 })
        end,
    },
    init = function()
        local notify = require 'notify'
        vim.notify = notify
        vim.keymap.set('n', '<leader>sm', '<Cmd>Telescope notify<CR>', { desc = '[S]earch Notify [M]mory' })
    end,
}
