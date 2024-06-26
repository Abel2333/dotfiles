-- Modern Comment
---@type LazyPluginSpec
return {
    'kevinhwang91/nvim-ufo',
    event = 'VeryLazy',
    dependencies = 'kevinhwang91/promise-async',
    -- enabled = false,
    init = function()
        -- local set_foldcolumn_for_file = vim.api.nvim_create_augroup('set_foldcolumn_for_file', { clear = true })
        --
        -- vim.api.nvim_create_autocmd({ 'BufRead', 'BufNewFile' }, {
        --     group = set_foldcolumn_for_file,
        --     callback = function()
        --         if vim.bo.buftype == '' then
        --             vim.wo.foldcolumn = '1'
        --         else
        --             vim.wo.foldcolumn = '0'
        --         end
        --     end,
        -- })
        vim.opt.foldcolumn = '1'

        -- vim.api.nvim_create_autocmd('OptionSet', {
        --     group = set_foldcolumn_for_file,
        --     pattern = 'buftype',
        --     callback = function()
        --         if vim.bo.buftype == '' then
        --             vim.wo.foldcolumn = '1'
        --         else
        --             vim.wo.foldcolumn = '0'
        --         end
        --     end,
        -- })

        vim.opt.foldlevel = 99
        vim.opt.foldlevelstart = 99
        vim.opt.foldenable = true
    end,

    opts = {
        close_fold_kinds_for_ft = {
            default = { 'import' },
        },
    },

    config = function(_, opts)
        local ufo = require 'ufo'
        ufo.setup(opts)

        vim.api.nvim_create_autocmd('LspAttach', {
            desc = "Setup ufo `K' with LSP hover",
            callback = function(args)
                local bufnr = args.buf

                vim.keymap.set('n', 'K', function()
                    local winid = ufo.peekFoldedLinesUnderCursor()
                    if not winid then
                        vim.lsp.buf.hover()
                    end
                end, { buffer = bufnr, desc = 'LSP: Signature help' })
            end,
        })
    end,
}
