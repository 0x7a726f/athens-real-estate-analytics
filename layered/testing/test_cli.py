#!/usr/bin/env python3
"""
CLI Test Suite - Layered Architecture (`layered/testing/test_cli.py`)
Tests the CLI interface (`layered/cli/urban_cli.py`) parser and subcommands.
"""

import sys
from pathlib import Path

CLI_DIR = Path(__file__).resolve().parent.parent / "cli"
sys.path.insert(0, str(CLI_DIR))

from urban_cli import build_parser  # noqa: E402


def run_cli_tests() -> None:
    print("=== [LAYERED] CLI TEST SUITE ===")
    parser = build_parser()

    # Test 1: Parse `evaluate` command arguments
    args_eval = parser.parse_args(
        ["evaluate", "--lat", "37.9862", "--lon", "23.7368", "--radius", "500", "--rooms", "3"]
    )
    assert args_eval.command == "evaluate"
    assert abs(args_eval.lat - 37.9862) < 1e-5
    assert args_eval.rooms == 3
    print("[PASS] 1. CLI Parser: `evaluate` subcommand & flags verified")

    # Test 2: Parse `neighborhoods` command
    args_nb = parser.parse_args(["neighborhoods"])
    assert args_nb.command == "neighborhoods"
    print("[PASS] 2. CLI Parser: `neighborhoods` subcommand verified")

    # Test 3: Parse `macro` command
    args_macro = parser.parse_args(["macro", "--city", "EL001C"])
    assert args_macro.command == "macro"
    assert args_macro.city == "EL001C"
    print("[PASS] 3. CLI Parser: `macro --city EL001C` subcommand verified")

    # Test 4: Parse `sync` command
    args_sync = parser.parse_args(["sync"])
    assert args_sync.command == "sync"
    print("[PASS] 4. CLI Parser: `sync` subcommand verified")
    print("=== ALL LAYERED CLI TESTS PASSED ===\n")


if __name__ == "__main__":
    run_cli_tests()
