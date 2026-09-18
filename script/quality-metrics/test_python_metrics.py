"""Real CLI regression tests for the metric/map adapter; run with the pinned CPython interpreter."""

from __future__ import annotations

import json
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from types import ModuleType
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .python import COLLECTOR, JsonValue, collector_module
else:
    from python import COLLECTOR, JsonValue, collector_module

ADAPTER = Path(__file__).with_name("python.py")
SOURCE = "def add(a, b):\n    return a + b\n\n\nprint(add(1, 2))\n"


# The collector owns the JSON helpers its documents are decoded with; the
# adapter loads it from its file and reads its Model the same way.
def collector_helpers(
    decoder: Callable[[ModuleType, str], Callable[[str], JsonValue]] = getattr,
    objector: Callable[[ModuleType, str], Callable[[JsonValue], Mapping[str, JsonValue]]] = getattr,
) -> tuple[Callable[[str], JsonValue], Callable[[JsonValue], Mapping[str, JsonValue]]]:
    collector = collector_module()
    return decoder(collector, "decode_json"), objector(collector, "json_object")


decode_json, json_object = collector_helpers()


def adapter(request: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run([sys.executable, str(ADAPTER)], input=request, text=True,
                          capture_output=True, timeout=30, check=False)


def test_maps_when_adapter_answers_with_the_collectors_prepared_maps() -> None:
    # Given the collector's own prepared document for a source.
    prepared = subprocess.run([sys.executable, str(COLLECTOR), "prepare"],
                              input=json.dumps({"path": "sample.py", "source": SOURCE}), text=True,
                              capture_output=True, timeout=30, check=False)
    assert prepared.returncode == 0, prepared.stderr
    expected = json_object(decode_json(prepared.stdout))
    coverage = json_object(expected["coverage"])
    # When the adapter measures the same source.
    result = adapter(json.dumps({"text": SOURCE, "path": "sample.py"}))
    assert result.returncode == 0, result.stderr
    answer = json_object(decode_json(result.stdout))
    # Then its maps are the collector's, byte for byte, next to the pinned toolchain and units.
    assert answer["runtime"] == "3.12.12"
    assert answer["tools"] == {"radon": "6.0.1", "cognitive-complexity": "1.3.0"}
    assert answer["statementMap"] == coverage["statementMap"]
    assert answer["code"] == expected["code"]
    assert answer["fnMap"] == {
        key: {field: json_object(function)[field] for field in ("name", "decl", "loc")}
        for key, function in json_object(coverage["fnMap"]).items()
    }
    units = answer["units"]
    assert isinstance(units, Sequence)
    assert [(json_object(unit)["kind"], json_object(unit)["name"]) for unit in units] == [
        ("module", "<module>"), ("python-function", "add"),
    ]


def test_request_when_shape_is_not_an_object_of_strings() -> None:
    # Given malformed requests, the adapter refuses before any analysis.
    for request, message in [("[]", "expected JSON object"),
                             ('{"text": 1, "path": "sample.py"}', "expected string text and path")]:
        result = adapter(request)
        assert result.returncode == 1, result.stdout
        assert result.stdout == ""
        assert message in result.stderr, result.stderr


def test_collector_when_its_location_has_no_module_loader() -> None:
    # Given a collector location whose suffix no import loader claims, the
    # adapter names the location instead of failing on an absent module.
    location = ADAPTER.with_name("collector.txt")
    try:
        _ = collector_module(location)
    except ValueError as error:
        assert str(error) == f"cannot load coverage collector from {location}", error
    else:
        raise AssertionError("an unloadable collector location was accepted")


if __name__ == "__main__":
    tests = [
        test_maps_when_adapter_answers_with_the_collectors_prepared_maps,
        test_request_when_shape_is_not_an_object_of_strings,
        test_collector_when_its_location_has_no_module_loader,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}", flush=True)
    print(json.dumps({"passed": len(tests), "python": sys.version.split()[0]}))
