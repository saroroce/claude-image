import os
import pty
import select
import sys
import time

account, token = sys.argv[1], sys.argv[2]
command = sys.argv[3:]

pid, fd = pty.fork()
if pid == 0:
    os.execvp(command[0], command)

captured = b""
stage = 0
deadline = time.time() + 20
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.2)
    if fd not in ready:
        continue
    try:
        chunk = os.read(fd, 4096)
    except OSError:
        break
    if not chunk:
        break
    captured += chunk
    if stage == 0 and b"Account ID:" in captured:
        os.write(fd, (account + "\r").encode())
        stage = 1
    elif stage == 1 and "API token".encode() in captured:
        time.sleep(0.3)
        os.write(fd, (token + "\r").encode())
        stage = 2

try:
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
except ChildProcessError:
    code = -1

sys.stdout.buffer.write(captured)
sys.stdout.buffer.flush()
sys.exit(code)
