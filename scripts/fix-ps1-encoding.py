#!/usr/bin/env python3
"""Normalise the PowerShell scripts in this repo for Windows PowerShell 5.1.

Windows PowerShell 5.1 reads a .ps1 file as ANSI unless the file carries a
UTF-8 BOM, which mangles any non-ASCII character in it.  This tool makes the
scripts safe two ways:

  1. every .ps1 is rewritten with a UTF-8 BOM, so the file decodes as UTF-8;
  2. every string LITERAL is checked to be ASCII-only, so the script still
     parses correctly even if the BOM is lost.

Comments may contain non-ASCII (em dashes and the like) - only string
literals have to be clean.

Usage:
    python scripts/fix-ps1-encoding.py
"""

import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FILES = [
    os.path.join(ROOT, "scripts", "start.ps1"),
    os.path.join(ROOT, "scripts", "restart.ps1"),
    os.path.join(ROOT, "scripts", "lib", "stack.ps1"),
    os.path.join(ROOT, "scripts", "lib", "run-service.ps1"),
]

BOM = b"\xef\xbb\xbf"


def non_ascii_literals(text):
    """Return (line_number, character) for non-ASCII chars inside string literals."""
    bad = []
    in_str = False
    for number, line in enumerate(text.split("\n"), 1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        for char in line:
            if char == '"':
                in_str = not in_str
            elif ord(char) > 127 and in_str:
                bad.append((number, char))
    return bad


def main():
    failures = []
    for path in FILES:
        if not os.path.exists(path):
            failures.append("missing: %s" % path)
            continue

        # utf-8-sig on read strips an existing BOM, so this is idempotent.
        with io.open(path, encoding="utf-8-sig", newline="") as handle:
            text = handle.read()

        bad = non_ascii_literals(text)
        if bad:
            failures.append("non-ascii inside a string literal in %s: %s" % (path, bad[:5]))
            continue

        try:
            with io.open(path, "w", encoding="utf-8-sig", newline="") as handle:
                handle.write(text)
        except OSError as exc:
            # Windows refuses to truncate a file another process has
            # memory-mapped ("... cannot be performed on a file with a
            # user-mapped section open").  A pure-ASCII file still parses
            # identically without the BOM, so warn instead of failing.
            if not text.isascii():
                failures.append("cannot rewrite %s (%s) and it is not ASCII-only" % (path, exc))
                continue
            print("warn %s left as-is (%s) - ASCII-only, so it parses without a BOM"
                  % (os.path.relpath(path, ROOT), exc))
            continue

        with io.open(path, "rb") as handle:
            has_bom = handle.read(3) == BOM
        print("ok %s (BOM=%s)" % (os.path.relpath(path, ROOT), has_bom))

    if failures:
        for failure in failures:
            sys.stderr.write("FAIL %s\n" % failure)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
