---@type LazyPluginSpec
return {
    'aserowy/tmux.nvim',
    cond = vim.env.TMUS ~= nil,
    opts = {},
    event = 'VeryLazy',
}
