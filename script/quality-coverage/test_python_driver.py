"""Execute the actual, explicitly named embedded source through its wire API."""

from __future__ import annotations

import json
import queue
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from collections.abc import Callable, Mapping
from typing import TYPE_CHECKING, Literal, TypeGuard, TypedDict

if TYPE_CHECKING:
    from .test_python import command, counts, manifest
    from .python import JsonValue, decode_json
else:
    from test_python import command, counts, manifest
    from python import decode_json


class ToolFrame(TypedDict):
    kind: Literal["tool_call"]
    callId: str
    cellId: str
    arguments: dict[str, int]


class ResultFrame(TypedDict):
    kind: Literal["result"]
    result: Mapping[str, JsonValue]

type DriverFrame = ToolFrame | ResultFrame


def is_driver_frame(value: JsonValue) -> TypeGuard[DriverFrame]:
    if not isinstance(value, Mapping):
        return False
    if value.get("kind") == "result":
        return isinstance(value.get("result"), Mapping)
    arguments = value.get("arguments")
    return (
        value.get("kind") == "tool_call"
        and isinstance(value.get("callId"), str)
        and isinstance(value.get("cellId"), str)
        and isinstance(arguments, Mapping)
        and all(isinstance(number, int) for number in arguments.values())
    )


def exchange(argv: list[str]) -> list[ResultFrame]:
    """Drive result and reverse-call frames using exact pipe events."""
    frames: queue.Queue[DriverFrame] = queue.Queue()
    with subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                          stderr=subprocess.PIPE, text=True) as process:
        stdin, stdout, stderr = process.stdin, process.stdout, process.stderr
        assert stdin is not None and stdout is not None and stderr is not None

        def receive(read_line: Callable[[], str] = stdout.readline) -> None:
            for line in iter(read_line, ""):
                frame = decode_json(line)
                assert is_driver_frame(frame), frame
                frames.put(frame)

        reader = threading.Thread(target=receive)
        reader.start()
        try:
            _ = stdin.write(json.dumps({"cellId": "one", "code": 'value = 41\nprint("hello")\nvalue + 1'}) + "\n")
            stdin.flush()
            first = frames.get(timeout=15)
            assert first["kind"] == "result", first
            _ = stdin.write(json.dumps({
                "cellId": "two",
                "code": "parallel([lambda: tool.echo(value=1), lambda: tool.echo(value=2)])",
            }) + "\n")
            stdin.flush()
            calls: list[ToolFrame] = []
            for _ in range(2):
                frame = frames.get(timeout=15)
                assert frame["kind"] == "tool_call", frame
                calls.append(frame)
            assert {frame["arguments"]["value"] for frame in calls} == {1, 2}
            for frame in reversed(calls):
                _ = stdin.write(json.dumps({
                    "callId": frame["callId"], "status": "completed",
                    "value": frame["arguments"]["value"] * 10,
                }) + "\n")
                stdin.flush()
            second = frames.get(timeout=15)
            assert second["kind"] == "result", second
            _ = stdin.write(json.dumps({"cellId": "three", "code": 'raise ValueError("cell failure")'}) + "\n")
            stdin.flush()
            third = frames.get(timeout=15)
            assert third["kind"] == "result", third
            stdin.close()
            assert process.wait(timeout=15) == 0, stderr.read()
            reader.join(timeout=15)
            assert not reader.is_alive()
            return [first, second, third]
        finally:
            if process.poll() is None:
                process.kill()
                _ = process.wait(timeout=15)
            reader.join(timeout=15)


def test_driver_when_real_source_uses_cells_and_reverse_calls() -> None:
    # Given the actual source binding, not a reduced/fake driver or new inventory.
    root = Path(__file__).resolve().parents[2]
    kernel = (root / "packages/machines/src/kernel.ts").read_text()
    source = kernel.split("const PYTHON_DRIVER = String.raw`", 1)[1].split("`;", 1)[0]
    identity = "packages/machines/src/kernel.ts#PYTHON_DRIVER"
    native = exchange([sys.executable, "-u", "-c", source])
    with tempfile.TemporaryDirectory() as temporary:
        directory = Path(temporary)
        row, = manifest(directory, {identity: source})
        # When the collector executes the same source and protocol conversation.
        instrumented = exchange(command(directory, identity))
        # Then cells and out-of-order host answers preserve all public results.
        assert instrumented == native, (instrumented, native)
        assert instrumented[0]["result"]["value"] == "42"
        assert instrumented[1]["result"]["value"] == "[10, 20]"
        assert instrumented[2]["result"]["status"] == "raised"
        hits = counts(directory, row)
        assert any(value > 0 for value in hits["s"].values())
        assert any(value > 0 for value in hits["f"].values())
        assert any(sum(value) > 0 for value in hits["b"].values())
        assert (directory / "child.trace.json").exists()
        assert not (directory / "child.failure.json").exists()
        print(json.dumps({
            "driverBytes": len(source.encode()),
            "statements": len(hits["s"]), "functions": len(hits["f"]),
            "branches": sum(map(len, hits["b"].values())), "lines": len(hits["lines"]),
        }))


if __name__ == "__main__":
    test_driver_when_real_source_uses_cells_and_reverse_calls()
    print("PASS test_driver_when_real_source_uses_cells_and_reverse_calls")
