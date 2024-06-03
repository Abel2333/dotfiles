-- [[ Import Plugins ]]
-- See lazy.nvim document to get more information
--     https://github.com/folke/lazy.nvim
return {
    'tpope/vim-sleuth', -- Detect tabstop and shiftwidth automatically

    -- INFO: This format will automatically import
    -- the plugins in specific folder.
    { import = 'abel.plugins.colorscheme' },

    { import = 'abel.plugins.ui' },

    { import = 'abel.plugins.tool' },

    { import = 'abel.plugins.treesitter' },

    { import = 'abel.plugins.mini' },

    { import = 'abel.plugins.editor' },

    { import = 'abel.plugins.lsp' },

    { import = 'abel.plugins.dap' },
}
