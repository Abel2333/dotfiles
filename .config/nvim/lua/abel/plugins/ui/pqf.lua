local custom = require 'abel.config.custom'

local signs = vim.tbl_extend('keep', {
    warning = custom.icons.diagnostic,
}, custom.icons.diagnostic)

---@type LazyPluginSpec
return {
    'yorickpeterse/nvim-pqf',
    event = 'LspAttach',
    opts = {
        signs = signs,
    },
}
