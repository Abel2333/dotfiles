local wezterm = require("wezterm")

local platform = function()
	local is_win = wezterm.target_triple:find("windows")
	local is_linux = wezterm.target_triple:find("linux")
	local is_mac = wezterm.target_triple:find("apple")

	local os = is_win and "windows" or is_linux and "linux" or is_mac and "mac" or "unknown"

	return {
		os = os,
		is_win = is_win,
		is_linux = is_linux,
		is_mac = is_mac,
	}
end

return platform
