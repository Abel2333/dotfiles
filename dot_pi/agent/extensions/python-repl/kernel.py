"""Run a persistent Python namespace over Pi's private JSONL channel.

Started only by runtime.mjs through the dedicated uv project. Requests arrive on
stdin; replies use fd 3 so Python and native stdout cannot corrupt the protocol.
This process executes trusted, approved code with the user's local permissions.
"""

import ast
import base64
import io
import json
import os
from pathlib import Path
import reprlib
import sys
import traceback

MAX_IMAGE_BYTES = 1024 * 1024
MAX_IMAGES = 4
MAX_COMMAND_BYTES = 100_000


class _ImageBuffer(io.BytesIO):
    def write(self, data):
        if self.tell() + len(data) > MAX_IMAGE_BYTES:
            raise ValueError("PNG exceeds the 1 MiB image limit")
        return super().write(data)


class _Kernel:
    def __init__(self):
        self.images = []
        self.namespace = {"__name__": "__main__", "display_png": self.display_png}
        self.formatter = reprlib.Repr()
        self.formatter.maxstring = 4096
        self.formatter.maxother = 4096
        self.formatter.maxlevel = 4
        self.future_flags = 0

    def display_png(self, source):
        """Attach a PNG from bytes or a path to the current execution.

        Accept at most four images, each at most 1 MiB and 4096 pixels per side.
        Read paths relative to the kernel cwd. Raise ValueError for invalid or
        oversized images, and OSError for inaccessible files. Return None.
        """
        if len(self.images) >= MAX_IMAGES:
            raise ValueError("At most four PNG images can be returned per execution")
        if isinstance(source, (str, os.PathLike)):
            with open(source, "rb") as image_file:
                data = image_file.read(MAX_IMAGE_BYTES + 1)
        elif isinstance(source, bytes):
            data = source
        else:
            raise TypeError("display_png expects PNG bytes or a file path")
        if len(data) > MAX_IMAGE_BYTES:
            raise ValueError("PNG exceeds the 1 MiB image limit")
        from PIL import Image

        with Image.open(io.BytesIO(data)) as image:
            if image.format != "PNG" or max(image.size) > 4096:
                raise ValueError("Expected a PNG no larger than 4096 pixels per side")
            image.verify()
        self.images.append(base64.b64encode(data).decode("ascii"))

    def _plots(self):
        # Importing pyplot is opt-in; status and plain calculations stay cheap.
        pyplot = sys.modules.get("matplotlib.pyplot")
        if pyplot is None:
            return
        numbers = pyplot.get_fignums()
        try:
            for number in numbers:
                with _ImageBuffer() as image:
                    pyplot.figure(number).savefig(image, format="png", dpi=100)
                    self.display_png(image.getvalue())
        finally:
            # Prevent old figures from being returned on every later execution.
            for number in numbers:
                pyplot.close(number)

    def _variables(self):
        variables = []
        for name, value in self.namespace.items():
            if not isinstance(name, str) or name.startswith("_") or name == "display_png":
                continue
            kind = type(value)
            # A custom metaclass can execute code on attribute access. Status
            # is metadata only, so avoid invoking it or an object's repr.
            label = kind.__name__ if type(kind) is type else "<custom metaclass>"
            variables.append({"name": name[:120], "type": label[:120]})
            if len(variables) == 100:
                break
        return variables

    def execute(self, command):
        self.images = []
        error = None
        value_text = ""
        try:
            tree = compile(command, "<python-repl>", "exec", ast.PyCF_ONLY_AST | self.future_flags)
            # Compile the whole cell first, so syntax errors cannot execute a
            # prefix and future imports also apply to the final expression.
            compiled = compile(tree, "<python-repl>", "exec", self.future_flags)
            import __future__

            for feature_name in __future__.all_feature_names:
                self.future_flags |= compiled.co_flags & getattr(__future__, feature_name).compiler_flag
            expression = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
            exec(compile(tree, "<python-repl>", "exec", self.future_flags), self.namespace)
            if expression is not None:
                value = eval(compile(ast.Expression(expression.value), "<python-repl>", "eval", self.future_flags), self.namespace)
                if value is not None:
                    self.namespace["_"] = value
                    value_text = self.formatter.repr(value)[:8192]
        except BaseException as exc:
            error = type(exc).__name__
            traceback.print_exc(limit=20)
        try:
            self._plots()
        except BaseException as exc:
            error = error or type(exc).__name__
            traceback.print_exc(limit=10)
        return {"error": error, "value": value_text, "images": self.images,
                "variables": self._variables(), "cwd": os.getcwd()}


def main():
    """Serve bounded JSON requests until parent EOF; fail on the wrong venv.

    argv[1] is the required uv project directory. Return on EOF; raise on invalid
    framing or environment. User exceptions are captured without resetting state.
    """
    expected = Path(sys.argv[1]).resolve() / ".venv"
    if Path(sys.prefix).resolve() != expected.resolve():
        raise RuntimeError(f"Expected isolated uv environment: {expected}")
    protocol = os.fdopen(3, "w", buffering=1, encoding="utf-8")
    requests = os.fdopen(os.dup(0), "rb")
    # input() and native stdin readers must not consume the next JSON request.
    with open(os.devnull, "rb") as empty:
        os.dup2(empty.fileno(), 0)
    kernel = _Kernel()
    protocol.write(json.dumps({"ready": True, "interpreter": sys.executable, "pid": os.getpid()}) + "\n")
    for line in iter(lambda: requests.readline(MAX_COMMAND_BYTES * 6 + 1024), b""):
        request = json.loads(line)
        command = request["command"]
        if len(command.encode("utf-8")) > MAX_COMMAND_BYTES:
            raise ValueError("Command exceeds 100000 bytes")
        result = kernel.execute(command)
        result["id"] = request["id"]
        # Output fences synchronize separate pipes. The parent resolves only
        # after both fences and the JSON reply arrive, regardless of pipe order.
        sys.stdout.flush()
        sys.stderr.flush()
        marker = ("\x1e" + request["id"] + "\x1f").encode("ascii")
        os.write(1, marker)
        os.write(2, marker)
        protocol.write(json.dumps(result, ensure_ascii=True) + "\n")


if __name__ == "__main__":
    main()
