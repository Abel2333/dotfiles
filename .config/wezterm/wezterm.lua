local Config = require("config")

return Config:init()
	:append(require("config.core"))
	:append(require("config.general"))
	:append(require("config.keymaps"))
	:append(require("config.launch")).options
