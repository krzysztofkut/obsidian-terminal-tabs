# Vault Terminal - PTY bridge.
#
# Started by the Obsidian plugin as:
#     python3 -u pty_helper.py <cols> <rows> <shell> [shell args...]
#
# stdin  : framed messages  [type:1 byte][length:4 bytes big-endian][payload]
#            type 0 -> bytes typed by the user, forwarded to the shell
#            type 1 -> resize, payload = struct ">HH" (cols, rows)
# stdout : raw terminal output of the shell
# exit   : exit code of the shell (128 + signal when killed by a signal)
#
# When stdin is closed (tab closed / Obsidian quit) the shell gets SIGHUP.
# Only the Python standard library is used on macOS / Linux.
# On Windows the "pywinpty" package is required (pip install pywinpty).

import os
import struct
import sys

T_DATA = 0
T_RESIZE = 1


def parse_frames(buf):
    frames = []
    off = 0
    n = len(buf)
    while n - off >= 5:
        kind = buf[off]
        size = struct.unpack_from(">I", buf, off + 1)[0]
        if n - off - 5 < size:
            break
        frames.append((kind, bytes(buf[off + 5:off + 5 + size])))
        off += 5 + size
    return frames, buf[off:]


# --------------------------------------------------------------------------
# macOS / Linux
# --------------------------------------------------------------------------
def run_unix(cols, rows, argv):
    import errno
    import fcntl
    import select
    import signal
    import termios
    import time

    def set_size(fd, c, r):
        try:
            fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
        except OSError:
            pass

    master, slave = os.openpty()
    set_size(slave, cols, rows)

    pid = os.fork()
    if pid == 0:  # ---- child: becomes the shell
        try:
            os.close(master)
            os.setsid()
            try:
                fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            except Exception:
                try:
                    os.close(os.open(os.ttyname(slave), os.O_RDWR))
                except Exception:
                    pass
            for fd in (0, 1, 2):
                os.dup2(slave, fd)
            if slave > 2:
                os.close(slave)
            for name in ("SIGPIPE", "SIGINT", "SIGQUIT", "SIGTERM", "SIGHUP", "SIGCHLD",
                         "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGXFSZ", "SIGWINCH"):
                if hasattr(signal, name):
                    try:
                        signal.signal(getattr(signal, name), signal.SIG_DFL)
                    except Exception:
                        pass
            os.execvp(argv[0], argv)
        except BaseException as exc:  # exec failed
            try:
                os.write(2, ("\r\n\x1b[31m[Vault Terminal] Cannot start %r: %s\x1b[0m\r\n"
                             % (argv[0], exc)).encode("utf-8", "replace"))
            except Exception:
                pass
        os._exit(127)

    # ---- parent: shuttle bytes between Obsidian and the pty
    os.close(slave)
    os.set_blocking(master, False)

    class Stop(Exception):
        pass

    def on_signal(signum, frame):
        raise Stop()

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGHUP, on_signal)
    signal.signal(signal.SIGINT, signal.SIG_IGN)

    def write_all(fd, data):
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            view = view[written:]

    def status_to_code(st):
        if os.WIFEXITED(st):
            return os.WEXITSTATUS(st)
        if os.WIFSIGNALED(st):
            return 128 + os.WTERMSIG(st)
        return 1

    def reap(timeout):
        deadline = time.time() + timeout
        while True:
            try:
                p, st = os.waitpid(pid, os.WNOHANG)
            except ChildProcessError:
                return 0
            if p == pid:
                return status_to_code(st)
            if time.time() >= deadline:
                return None
            time.sleep(0.02)

    def kill_shell():
        for sig in (signal.SIGHUP, signal.SIGKILL):
            try:
                os.kill(pid, sig)
            except OSError:
                return reap(0) or 0
            code = reap(1.5)
            if code is not None:
                return code
        return 1

    inbuf = b""
    pending = bytearray()
    code = None

    try:
        while True:
            rlist = [master, 0]
            wlist = [master] if pending else []
            try:
                r, w, _ = select.select(rlist, wlist, [], 0.25)
            except InterruptedError:
                continue

            if master in r:
                try:
                    data = os.read(master, 65536)
                except BlockingIOError:
                    data = None
                except OSError as exc:  # EIO: every slave fd is closed
                    data = b"" if exc.errno in (errno.EIO, errno.EBADF) else None
                if data == b"":
                    break
                if data:
                    write_all(1, data)

            if pending and master in w:
                try:
                    n = os.write(master, pending)
                    del pending[:n]
                except BlockingIOError:
                    pass
                except OSError:
                    pending.clear()

            if 0 in r:
                data = os.read(0, 65536)
                if not data:  # Obsidian closed the tab
                    code = kill_shell()
                    break
                inbuf += data
                frames, inbuf = parse_frames(inbuf)
                for kind, payload in frames:
                    if kind == T_DATA:
                        pending.extend(payload)
                    elif kind == T_RESIZE and len(payload) >= 4:
                        c, rr = struct.unpack(">HH", payload[:4])
                        set_size(master, c, rr)  # kernel sends SIGWINCH

            if not r:
                # Shell may be gone while a background job still holds the pty.
                done = reap(0)
                if done is not None:
                    code = done
                    break
    except Stop:
        code = kill_shell()
    except BrokenPipeError:
        code = kill_shell()

    # Flush whatever is still buffered in the pty.
    try:
        while True:
            data = os.read(master, 65536)
            if not data:
                break
            write_all(1, data)
    except Exception:
        pass

    if code is None:
        code = reap(2.0)
        if code is None:
            code = kill_shell()
    return code


# --------------------------------------------------------------------------
# Windows (ConPTY through pywinpty)
# --------------------------------------------------------------------------
def run_windows(cols, rows, argv):
    import codecs
    import threading
    import time

    out = sys.stdout.buffer
    try:
        from winpty import PtyProcess
    except ImportError:
        msg = ("\r\n\x1b[31m[Vault Terminal] The Python package \"pywinpty\" is missing.\x1b[0m\r\n"
               "Install it and reopen the tab:\r\n\r\n    \"%s\" -m pip install pywinpty\r\n" % sys.executable)
        out.write(msg.encode("utf-8"))
        out.flush()
        return 3

    try:
        proc = PtyProcess.spawn(argv, cwd=os.getcwd(), env=dict(os.environ), dimensions=(rows, cols))
    except Exception as exc:
        out.write(("\r\n\x1b[31m[Vault Terminal] Cannot start %r: %s\x1b[0m\r\n"
                   % (argv[0], exc)).encode("utf-8", "replace"))
        out.flush()
        return 127

    def read_exact(stream, n):
        chunks = []
        while n > 0:
            chunk = stream.read1(n) if hasattr(stream, "read1") else stream.read(n)
            if not chunk:
                return None
            chunks.append(chunk)
            n -= len(chunk)
        return b"".join(chunks)

    def pump_input():
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        stream = sys.stdin.buffer
        while True:
            head = read_exact(stream, 5)
            if head is None:
                break
            size = struct.unpack(">I", head[1:5])[0]
            payload = read_exact(stream, size) if size else b""
            if payload is None:
                break
            try:
                if head[0] == T_DATA:
                    text = decoder.decode(payload)
                    if text:
                        proc.write(text)
                elif head[0] == T_RESIZE and len(payload) >= 4:
                    c, r = struct.unpack(">HH", payload[:4])
                    proc.setwinsize(r, c)
            except Exception:
                pass
        try:  # Obsidian closed the tab
            proc.terminate(force=True)
        except Exception:
            pass
        os._exit(0)

    threading.Thread(target=pump_input, daemon=True).start()

    while True:
        try:
            data = proc.read(65536)
        except EOFError:
            break
        except Exception:
            break
        if data:
            out.write(data.encode("utf-8", "replace"))
            out.flush()
        elif not proc.isalive():
            break
        else:
            time.sleep(0.01)

    for _ in range(100):
        if not proc.isalive():
            break
        time.sleep(0.05)
    status = getattr(proc, "exitstatus", None)
    return status if isinstance(status, int) else 0


def main():
    if len(sys.argv) < 4:
        sys.stderr.write("usage: pty_helper.py <cols> <rows> <shell> [args...]\n")
        return 2
    cols = max(1, int(sys.argv[1]))
    rows = max(1, int(sys.argv[2]))
    argv = sys.argv[3:]
    if os.name == "nt":
        return run_windows(cols, rows, argv)
    return run_unix(cols, rows, argv)


if __name__ == "__main__":
    code = main()
    try:
        sys.stdout.flush()
    except Exception:
        pass
    os._exit(code if isinstance(code, int) else 0)
