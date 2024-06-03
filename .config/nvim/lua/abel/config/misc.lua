-- [[ Some misc settings ]]
-- Envrionment variable
-- NOTE: vim.fn.joinpath requires neovim version >= 0.10.0
--
---@diagnostic disable-next-line: param-type-mismatch
vim.env.LAZYROOT = vim.fs.joinpath(vim.fn.stdpath 'data', 'lazy')

vim.cmd.aunmenu [[PopUp.How-to\ disable\ mouse]]
vim.cmd.aunmenu [[PopUp.-1-]]
