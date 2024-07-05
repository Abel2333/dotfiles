local wezterm = require("wezterm")
local platform = require("utils.platform")()

local PATH_SEP = platform.is_win and "\\" or "/"

return wezterm.config_dir .. PATH_SEP .. "assets" .. PATH_SEP .. "Saber.jpg"
