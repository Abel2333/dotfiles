-- Highlight todo, notes, etc in comments
return {
    { 'folke/todo-comments.nvim', event = 'VimEnter', dependencies = { 'nvim-lua/plenary.nvim' }, opts = { signs = false } },
}
-- vim: ts=4 sts=4 sw=4 et
