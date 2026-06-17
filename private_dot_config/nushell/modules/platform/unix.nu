# Unix-specific environment customizations.

$env.GOBIN = ($nu.home-dir | path join ".local" "bin")
$env.PATH = ($env.PATH | prepend [
    ($nu.home-dir | path join ".local" "bin"),
    ($nu.home-dir | path join ".cargo" "bin"),
    ($nu.home-dir | path join ".pixi" "bin")
    ($nu.home-dir | path join ".dotnet"),
])
