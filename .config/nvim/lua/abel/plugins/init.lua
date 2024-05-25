-- [[ Import Plugins ]]
-- See lazy.nvim document to get more information
--     https://github.com/folke/lazy.nvim
return {
    -- NOTE: Plugins can be added with a link
    -- (or for a github repo :`owner/repo' link).
    'tpope/vim-sleuth', -- Detect tabstop and shiftwidth automatically

    -- NOTE: Plugins can also be added by using a table,
    -- with the first argument being the link and the following
    -- keys can be used to configure plugin behavior/loading/etc.
    --
    -- Use `opts=[]' to force a plugin to be loaded.
    --
    -- This is equivalent to:
    --     require('Comment').setup({})

    -- "gc" to comment visual regions/lines
    { 'numToStr/Comment.nvim', opts = {} },

    -- modular approach: using `require \`path/name\'' will
    -- include a plugin definition from file lua/path/name.lua

    { import = 'abel.plugins.colorscheme' },

    { import = 'abel.plugins.ui' },

    { import = 'abel.plugins.tool' },

    { import = 'abel.plugins.mini' },

    require 'abel.plugins.treesitter',

    { import = 'abel.plugins.editor' },

    { import = 'abel.plugins.lsp' },

    { import = 'abel.plugins.dap' },
}
