"""Attach a private controlling TTY while preserving stdin and stdout."""

import fcntl
import os
import sys
import termios


def main():
    fd = int(sys.argv[1])
    fcntl.ioctl(fd, termios.TIOCSCTTY, 0)
    os.close(fd)
    os.execvp(sys.argv[2], sys.argv[2:])


if __name__ == "__main__":
    main()
