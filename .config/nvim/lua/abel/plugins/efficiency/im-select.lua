--- Auto change input method in normal mode
---@type LazyPluginSpec
return {
    'keaising/im-select.nvim',
    config = function()
        require('im_select').setup {}
    end,
}
