local theme = require 'abel.config.theme'

---@type LazyPluginSpec
return {
    'catppuccin/nvim',
    name = 'catppuccin',
    lazy = true,
    opts = {
        term_colors = true,
        custom_highlights = theme.catppuccin_highlight,
        transparent_background = true,
        integrations = {
            aerial = true,
            fidget = true,
            markdown = true,
            mason = true,
            neotree = true,
            native_lsp = {
                underlines = {
                    errors = { 'undercurl' },
                    hints = { 'undercurl' },
                    warnings = { 'undercurl' },
                    information = { 'undercurl' },
                },
            },
            navic = {
                enabled = true,
            },
            noice = true,
            notify = true,
            treesitter_context = true,
            octo = true,
            overseer = true,
            symbols_outline = true,
            illuminate = true,
            ufo = false,
            which_key = true,
            window_picker = true,
        },
    },
}
