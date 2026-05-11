export def state [] {
    try {
        let buffer = (commandline)
        let cursor = (commandline get-cursor)
        {
            buffer: $buffer
            cursor: $cursor
            left: ($buffer | str substring 0..$cursor)
            right: ($buffer | str substring $cursor..)
        }
    } catch {
        {
            buffer: ""
            cursor: 0
            left: ""
            right: ""
        }
    }
}
