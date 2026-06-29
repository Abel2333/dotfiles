# Unix-specific environment customizations.

use $"($nu.default-config-dir)/lib/path.nu" prepend-paths

$env.GOBIN = ($nu.home-dir | path join ".local" "bin")
prepend-paths [
    ($nu.home-dir | path join ".local" "bin"),
    ($nu.home-dir | path join ".cargo" "bin"),
    ($nu.home-dir | path join ".local" "share" "npm" "bin"),
    ($nu.home-dir | path join ".dotnet"),
]
