"""Generate synthetic fixtures in isolation, then publish their pinned inventory.

Optional regeneration only: Python 3 plus FFmpeg with libx264/AAC/libmp3lame, lavfi and
-display_rotation support. Native FFmpeg is NOT required by npm run check.
Different FFmpeg/x264 builds may change encoded bytes; review the new manifest
and run all checks. Existing local extras are never included in the inventory.
"""
from pathlib import Path
import subprocess, struct, wave, math, zlib, json, hashlib
import tempfile, shutil, os

STATIC_DRAFTS = ('legacy-unversioned.json', 'legacy-unversioned.migrated.json', 'legacy-unversioned.v2.json')

def generate(root):
    def ff(*args):
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', *args], check=True, timeout=45)
    def png(name, width, height, rgb):
        def chunk(kind, data):
            return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
        pixels = b''.join(b'\x00' + bytes(rgb) * width for _ in range(height))
        (root / name).write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!2I5B', width, height, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(pixels)) + chunk(b'IEND', b''))
    png('landscape-red.png', 160, 90, (255, 0, 0))
    png('portrait-blue.png', 90, 160, (0, 0, 255))
    ff('-f', 'lavfi', '-i', 'color=c=green:s=160x90:r=24:d=1', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', str(root / 'silent-video.mp4'))
    for tag, rate in [('23976', '24000/1001'), ('24', '24'), ('2997', '30000/1001'), ('30', '30'), ('60', '60')]:
        ff('-f', 'lavfi', '-i', f'color=c=blue:s=160x90:r={rate}:d=1', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', str(root / f'rate-{tag}.mp4'))
    for name, args in [('sar-wide.mp4', ['-vf', 'setsar=2']), ('vfr.mp4', ['-vf', "select='if(lt(t,0.5),not(mod(n,2)),not(mod(n,3)))'", '-fps_mode', 'vfr'])]:
        ff('-f', 'lavfi', '-i', 'smptebars=size=160x90:rate=60:duration=1', *args, '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', str(root / name))
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
    # Tagged six-second MP3: native gapless decode is the worker timing oracle.
    gapless_source = root / '_gapless-source.wav'
    with wave.open(str(root / 'tone-impulses.wav'), 'rb') as original:
        params, data = original.getparams(), original.readframes(original.getnframes())
    with wave.open(str(gapless_source), 'wb') as repeated:
        repeated.setparams(params)
        repeated.writeframes(data * 6)
    ff('-i', str(gapless_source), '-c:a', 'libmp3lame', '-b:a', '192k', '-write_xing', '1', str(root / 'gapless-pulses.mp3'))
    gapless_source.unlink()
    (root / 'corrupt.mp4').write_bytes(b'not an mp4\x00\xff')
    (root / 'unsupported.bin').write_bytes(b'CLIPBRAID_SYNTHETIC_UNSUPPORTED_FORMAT\x00')
    cases={'invalid-arrays.json':{'mediaAssets':{}},'invalid-json.json':None,'duplicate-ids.json':{'mediaAssets':[{'id':'same'},{'id':'same'}]},'invalid-timings.json':{'mediaAssets':[{'id':'bad','startTime':-1,'duration':1e100}]},'future-version.json':{'schemaVersion':9999,'mediaAssets':[],'audioTracks':[]}}
    for name,data in cases.items(): (root/'drafts'/name).write_text('{invalid' if data is None else json.dumps(data)+'\n')
    manifest={str(p.relative_to(root)):{'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(root.rglob('*')) if p.is_file() and p.suffix not in ('.md',) and p.name != 'manifest.json'}
    (root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')

def main():
    destination = Path(__file__).resolve().parent.parent / 'tests/fixtures'
    try:
        help_text = subprocess.check_output(['ffmpeg', '-hide_banner', '-h', 'full'], stderr=subprocess.STDOUT, timeout=20).decode(errors='replace')
        if '-display_rotation' not in help_text:
            raise SystemExit('Fixture regeneration needs FFmpeg with -display_rotation support; existing fixtures were not changed.')
        version = subprocess.check_output(['ffmpeg', '-version'], text=True, timeout=10).splitlines()[0]
    except FileNotFoundError:
        raise SystemExit('Optional fixture regeneration requires native FFmpeg; npm run check does not.')
    with tempfile.TemporaryDirectory(prefix='clipbraid-fixture-generation-') as temporary:
        staged = Path(temporary)
        (staged / 'drafts').mkdir()
        for name in STATIC_DRAFTS:
            shutil.copyfile(destination / 'drafts' / name, staged / 'drafts' / name)
        generate(staged)
        # The temporary tree contains only generated files and explicit golden drafts.
        manifest = json.loads((staged / 'manifest.json').read_text())
        for name in [*manifest, 'manifest.json']:
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            pending = target.with_name(target.name + '.generating')
            try:
                shutil.copyfile(staged / name, pending)
                os.replace(pending, target)
            finally:
                pending.unlink(missing_ok=True)
        reports = destination.parent.parent / 'reports'
        reports.mkdir(exist_ok=True)
        (reports / 'fixture-generation.json').write_text(json.dumps({'ffmpeg': version, 'manifestSha256': hashlib.sha256((destination / 'manifest.json').read_bytes()).hexdigest(), 'fixtures': len(manifest)}, indent=2) + '\n')

if __name__ == '__main__':
    main()
