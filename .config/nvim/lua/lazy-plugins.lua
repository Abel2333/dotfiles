-- [[ Configure and install plugins ]]
--
-- To check the current status of plugins, run
--     :Lazy
--
-- Press `?' in this menu for help. Use `:q' to close the window.
--
-- To update plugins, run
--     :Lazy update
--
-- NOTE: Install plugins here.
require('lazy').setup({
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

    require 'plugins.gitsigns',

    require 'plugins.which-key',

    require 'plugins.telescope',

    require 'plugins.lspconfig',

    require 'plugins.conform',

    require 'plugins.cmp',

    require 'plugins.catppuccin',

    require 'plugins.todo-comments',

    require 'plugins.mini',

    require 'plugins.treesitter',

    require 'plugins.neo-tree',

    require 'plugins.autopairs',

    require 'plugins.debug',

    require 'plugins.indent_line',

    require 'plugins.lint',

    require 'plugins.alpha',

    require 'plugins.persistence',

    require 'plugins.lualine',
}, {
    ui = {
        -- If you are using a Nerd Font: set icons to an empty table which will use the
        -- default lazy.nvim defined Nerd Font icons, otherwise define a unicode icons table
        icons = vim.g.have_nerd_font and {} or {
            cmd = '⌘',
            config = '🛠',
            event = '📅',
            ft = '📂',
            init = '⚙',
            keys = '🗝',
            plugin = '🔌',
            runtime = '💻',
            require = '🌙',
            source = '📄',
            start = '🚀',
            task = '📌',
            lazy = '💤 ',
        },
    },
})

-- vim: ts=4 sts=4 sw=4 et
