-- Open new nvim in current nvim instance

---@type LazyPluginSpec
return {
    'willothy/flatten.nvim',
    opts = {
        nest_if_no_args = true,
        window = {
            open = 'alternate',
        },
    },
}
