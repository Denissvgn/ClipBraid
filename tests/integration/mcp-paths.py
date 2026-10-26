"""Optional POSIX filesystem fault probe. Requires Python 3; not an npm-check prerequisite."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
if not hasattr(os, 'mkfifo'):
    raise SystemExit('This optional probe requires POSIX named pipes.')
with tempfile.TemporaryDirectory(prefix='clipbraid-mcp-fifo-') as directory:
    fifo = Path(directory) / 'log'
    os.mkfifo(fifo)
    source = f"""import {{readBounded}} from {json.dumps((root / 'mcp-server/storage.js').as_uri())};
try {{ await readBounded(process.argv[1], 128, true); process.exitCode=2; }}
catch(error) {{ if(!/regular file/.test(error.message))throw error; }}
"""
    subprocess.run(['node', '--input-type=module', '-e', source, str(fifo)], check=True, timeout=2)
print('Named-pipe input rejected without blocking.')
