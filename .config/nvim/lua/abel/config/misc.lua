-- [[ Some misc settings ]]
-- Envrionment variable
-- NOTE: may have some error under Windows Envrionment.
-- Using vim.fs.joinpath in nvim nightly version can resolve it.
vim.env.LAZYROOT = vim.fn.stdpath 'data' .. '/lazy'

vim.cmd.aunmenu [[PopUp.How-to\ disable\ mouse]]
vim.cmd.aunmenu [[PopUp.-1-]]
