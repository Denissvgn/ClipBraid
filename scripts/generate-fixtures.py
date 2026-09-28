"""Generate redistributable synthetic media. Requires native ffmpeg, not a test prerequisite."""
from pathlib import Path
import subprocess, struct, wave, math, zlib, json, hashlib
root = Path(__file__).resolve().parent.parent / 'tests/fixtures'
def ff(*args):
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args], check=True, timeout=45)
def png(name, width, height, rgb):
    def chunk(kind, data):
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    pixels = b''.join(b'\x00' + bytes(rgb) * width for _ in range(height))
    (root / name).write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))
png('landscape-red.png', 160, 90, (255, 0, 0))
png('portrait-blue.png', 90, 160, (0, 0, 255))
ff('-f', 'lavfi', '-i', 'color=c=red:s=1600x900:r=30:d=0.5', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-crf', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', str(root / 'oversized-av.mp4'))
ff('-f', 'lavfi', '-i', 'smptebars=size=160x90:rate=30000/1001:duration=1.001', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1.001', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-shortest', '-movflags', '+faststart', str(root / 'bars-fractional-av.mp4'))
ff('-display_rotation:v:0', '270', '-i', str(root / 'bars-fractional-av.mp4'), '-c', 'copy', str(root / 'rotated-av.mp4'))
with wave.open(str(root / 'tone-impulses.wav'), 'wb') as w:
    w.setparams((1, 2, 48000, 48000, 'NONE', 'not compressed'))
    samples=[]
    for i in range(48000):
        t=i/48000
        v=0.2*math.sin(2*math.pi*440*t) if 0.2 <= t < 0.4 else 0
        if i in (4800, 38400): v=0.8
        samples.append(int(v*32767))
    w.writeframes(struct.pack('<48000h', *samples))
(root / 'corrupt.mp4').write_bytes(b'not an mp4\x00\xff')
(root / 'unsupported.bin').write_bytes(b'CLIPBRAID_SYNTHETIC_UNSUPPORTED_FORMAT\x00')
cases={'invalid-arrays.json':{'mediaAssets':{}},'invalid-json.json':None,'duplicate-ids.json':{'mediaAssets':[{'id':'same'},{'id':'same'}]},'invalid-timings.json':{'mediaAssets':[{'id':'bad','startTime':-1,'duration':1e100}]},'future-version.json':{'schemaVersion':9999,'mediaAssets':[],'audioTracks':[]}}
for name,data in cases.items(): (root/'drafts'/name).write_text('{invalid' if data is None else json.dumps(data)+'\n')
manifest={str(p.relative_to(root)):{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(root.rglob('*')) if p.is_file() and p.suffix not in ('.md',) and p.name != 'manifest.json'}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
