export def timestamp-column [columns: list<string>] {
    $columns
    | where { |name| $name in ["start_timestamp", "timestamp", "time", "start_time"] }
    | first
}

export def timestamp-display [timestamp: any] {
    let dt = if (($timestamp | describe) == "datetime") {
        $timestamp
    } else {
        try { $timestamp | into datetime } catch { null }
    }

    if $dt == null {
        return ""
    }

    let age = (date now) - $dt
    let mins = (($age / 1min) | math floor | into int)
    let hours = (($age / 1hr) | math floor | into int)
    let days = (($age / 1day) | math floor | into int)

    if $age < 1min {
        "now"
    } else if $age < 2min {
        "a minute ago"
    } else if $age < 1hr {
        $"($mins) minutes ago"
    } else if $age < 2hr {
        "an hour ago"
    } else if $age < 1day {
        $"($hours) hours ago"
    } else if $age < 2day {
        "a day ago"
    } else if $age < 90day {
        $"($days) days ago"
    } else {
        $dt | format date "%Y-%m-%d %H:%M"
    }
}
