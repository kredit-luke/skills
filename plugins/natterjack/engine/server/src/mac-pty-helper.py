#!/usr/bin/env python3
"""
Runs a command under a freshly forked pseudo-terminal and relays its I/O over this
process's own stdin/stdout. Used by mcp-login.ts on macOS instead of BSD `script`.

`script` needs the *invoking* process to already have a controlling terminal, to copy
its settings onto the pty it creates. The dashboard server runs detached (so it survives
the terminal that started it being closed), so it has no controlling terminal, and
`script -q /dev/null ...` fails there with "tcgetattr/ioctl: Operation not supported on
socket". os.forkpty() doesn't have that requirement: it always creates a brand new
terminal session for the child, whether or not the caller has one. Linux's `script`
(util-linux) doesn't need this workaround; it's only used on darwin (see mcp-login.ts).
"""
import os
import pty
import select
import sys


def main() -> int:
    argv = sys.argv[1:]
    pid, master_fd = pty.fork()
    if pid == 0:
        os.execvp(argv[0], argv)

    stdin_open = True
    try:
        while True:
            watch = [master_fd, 0] if stdin_open else [master_fd]
            ready, _, _ = select.select(watch, [], [])
            if 0 in ready:
                try:
                    data = os.read(0, 4096)
                except OSError:
                    data = b""
                if data:
                    try:
                        os.write(master_fd, data)
                    except OSError:
                        pass
                else:
                    # EOF: stop watching stdin, or select would keep reporting it ready forever
                    stdin_open = False
            if master_fd in ready:
                try:
                    data = os.read(master_fd, 4096)
                except OSError:
                    break  # the child exited: macOS raises EIO once the pty's slave side is gone
                if not data:
                    break
                os.write(1, data)
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass

    _, status = os.waitpid(pid, 0)
    return status >> 8 if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)


if __name__ == "__main__":
    sys.exit(main())
