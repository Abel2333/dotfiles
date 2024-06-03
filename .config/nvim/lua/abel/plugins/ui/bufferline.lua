local custom = require 'abel.config.custom'
local utils = require 'abel.util.misc'

local mode = custom.prefer_tabpage and 'tab' or 'buffer'
local modes = custom.prefer_tabpage and 'tabs' or 'buffers'

---@type LazyPluginSpec
return {
    'akinsho/bufferline.nvim',
    event = 'VeryLazy',
    dependencies = { 'nvim-tree/nvim-web-devicons' },
    keys = {
        { '<M-1>', '<Cmd>BufferLineGoToBuffer 1<CR>', desc = 'Go to ' .. mode .. ' 1' },
        { '<M-2>', '<Cmd>BufferLineGoToBuffer 2<CR>', desc = 'Go to ' .. mode .. ' 2' },
        { '<M-3>', '<Cmd>BufferLineGoToBuffer 3<CR>', desc = 'Go to ' .. mode .. ' 3' },
        { '<M-4>', '<Cmd>BufferLineGoToBuffer 4<CR>', desc = 'Go to ' .. mode .. ' 4' },
        { '<M-5>', '<Cmd>BufferLineGoToBuffer 5<CR>', desc = 'Go to ' .. mode .. ' 5' },
        { '<M-6>', '<Cmd>BufferLineGoToBuffer 6<CR>', desc = 'Go to ' .. mode .. ' 6' },
        { '<M-7>', '<Cmd>BufferLineGoToBuffer 7<CR>', desc = 'Go to ' .. mode .. ' 7' },
        { '<M-8>', '<Cmd>BufferLineGoToBuffer 8<CR>', desc = 'Go to ' .. mode .. ' 8' },
        { '<M-9>', '<Cmd>BufferLineGoToBuffer 9<CR>', desc = 'Go to ' .. mode .. ' 9' },

        custom.prefer_tabpage and { '<M-S-Right>', '<Cmd>+tabmove<CR>', desc = 'Move tab to next' }
            or { '<M-S-Right>', '<Cmd>BufferLineMoveNext<CR>', desc = 'Move buffer to next' },
        custom.prefer_tabpage and { '<M-S-Left>', '<Cmd>-tabmove<CR>', desc = 'Move tab to previous' }
            or { '<M-S-Right>', '<Cmd>BufferLineMovePrev<CR>', desc = 'Move buffer to previous' },

        { ']b', '<cmd>BufferLineCycleNext<CR>', desc = 'Next ' .. utils.firstToUpper(mode) },
        { '[b', '<cmd>BufferLineCyclePrev<CR>', desc = 'Prev' .. utils.firstToUpper(mode) },
        { '<leader>bp', '<Cmd>BufferLineTogglePin<CR>', desc = 'Toggle [P]in' },
        { '<leader>bP', '<Cmd>BufferLineGroupClose ungrouped<CR>', desc = 'Delete Non-[P]inned ' .. utils.firstToUpper(modes) },
        { '<leader>bo', '<Cmd>BufferLineCloseOthers<CR>', desc = 'Delete [O]ther ' .. utils.firstToUpper(modes) },
        { '<leader>br', '<Cmd>BufferLineCloseRight<CR>', desc = 'Delete ' .. utils.firstToUpper(modes) .. ' to the [R]ight' },
        { '<leader>bl', '<Cmd>BufferLineCloseLeft<CR>', desc = 'Delete ' .. utils.firstToUpper(modes) .. ' to the [L]eft' },
    },
    config = function()
        require('bufferline').setup {
            options = {
                hover = {
                    enabled = true,
                    delay = 0,
                    reveal = { 'close' },
                },
                -- numbers = custom.prefer_tabpage and "ordinal" or "none",
                --show_close_icon = false,
                buffer_close_icon = custom.icons.misc.close,
                offsets = {
                    {
                        filetype = 'neo-tree',
                        text = 'Explorer',
                        text_align = 'center',
                        saperator = false,
                    },
                    {
                        filetype = 'aerial',
                        text = 'Outline',
                        text_align = 'center',
                        saperator = true,
                    },
                    {
                        filetype = 'Outline',
                        text = 'Outline',
                        text_align = 'center',
                        saperator = true,
                    },
                    {
                        filetype = 'dbui',
                        text = 'Database Manager',
                        text_align = 'center',
                        saperator = true,
                    },
                    {
                        filetype = 'DiffviewFiles',
                        text = 'Source Control',
                        text_align = 'center',
                        separator = true,
                    },
                    {
                        filetype = 'httpResult',
                        text = 'Http Result',
                        text_align = 'center',
                        saperator = true,
                    },
                    {
                        filetype = 'OverseerList',
                        text = 'Tasks',
                        text_align = 'center',
                        saperator = true,
                    },
                    {
                        filetype = 'flutterToolsOutline',
                        text = 'Flutter Outline',
                        text_align = 'center',
                        saperator = true,
                    },
                },
                diagnostics = 'nvim_lsp',
                diagnostics_indicator = function(count)
                    return '(' .. count .. ')'
                end,
                show_duplicate_prefix = false,
                always_show_bufferline = true,
                sort_by = custom.prefer_tabpage and 'tabs' or 'insert_after_current',
            },
        }
    end,
}
