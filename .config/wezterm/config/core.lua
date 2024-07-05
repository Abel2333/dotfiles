local wezterm = require 'wezterm'
-- local background = require 'utils.background'

return {
    animation_fps = 60,
    max_fps = 60,
    front_end = 'WebGpu',
    webgpu_power_preference = 'HighPerformance',

    -- fonts
    font = wezterm.font_with_fallback {
        'FiraCode Nerd Font',
        'LXGW WenKai',
    },
    font_size = 16,
    color_scheme = 'Catppuccin Macchiato',

    -- Tab bar
    enable_tab_bar = true,
    use_fancy_tab_bar = false,
    tab_max_width = 25,
    hide_tab_bar_if_only_one_tab = true,
    window_decorations = 'INTEGRATED_BUTTONS|RESIZE',
    show_new_tab_button_in_tab_bar = false,
    switch_to_last_active_tab_when_closing_tab = true,

    -- Background
    window_background_opacity = 0.95,
    text_background_opacity = 0.95,
    -- window_background_image = background,
    window_background_image_hsb = {
        brightness = 0.1, -- 调整亮度
        hue = 1.0, -- 保持原色调
        saturation = 1.0, -- 保持原饱和度
    },

    -- Window
    adjust_window_size_when_changing_font_size = false,
    window_padding = {
        left = 10,
        right = 10,
        top = 10,
        bottom = 5,
    },
}
