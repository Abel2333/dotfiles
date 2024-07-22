-- Wrapper to avoid local defined variables file non-existent.
local M = {}

local _, defined = pcall(require, 'abel.config.defined-locals')

if _ and type(defined) == 'table' then
    M = defined
end

return M
