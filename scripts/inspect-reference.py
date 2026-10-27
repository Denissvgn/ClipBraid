"""Independent, optional full-reference inspection. Requires NumPy and native FFmpeg/ffprobe.

Input media and every generated artifact must remain in ignored local storage.
This inspector supports the legacy embedded, unfiltered video reference. It does
not certify arbitrary projects, listening quality, physical storage or devices.
"""
import array
import base64
import hashlib
import json
import math
import pathlib
import subprocess
import sys
import numpy as np


def run(args, timeout=180):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=True)
    return result.stdout


def ffmpeg(*args):
    return run(["ffmpeg", "-v", "error", "-nostdin", "-threads", "1", "-filter_threads", "1", "-filter_complex_threads", "1", *map(str, args)])


def sha(data):
    return hashlib.sha256(data).hexdigest()


def inspect(project_file, folder):
    folder = pathlib.Path(folder)
    raw = pathlib.Path(project_file).read_bytes()
    project = json.loads(raw)
    result = json.loads((folder / "result.json").read_text())
    if result["inputSha256"] != sha(raw) or result["status"] != "passed":
        raise ValueError("Reference run failed or its input changed")
    clips, tracks = project["mediaAssets"], project["audioTracks"]
    if len(clips) != 23 or any(c["type"] != "video" or c.get("filter", "none") != "none" for c in clips):
        raise ValueError("This inspector requires the 23-clip unfiltered embedded reference")
    if project["aspectRatio"] != "16:9" or project["fitMode"] != "contain":
        raise ValueError("Unsupported reference aspect/fit policy")
    output = folder / "output.mp4"
    output_bytes = output.read_bytes()
    if sha(output_bytes) != result["received"]["sha256"]:
        raise ValueError("Received output changed")
    probe = json.loads(run(["ffprobe", "-v", "error", "-count_frames", "-show_streams", "-show_format", "-of", "json", str(output)]))
    (folder / "ffprobe.json").write_text(json.dumps(probe, indent=2) + "\n")
    video = next(s for s in probe["streams"] if s["codec_type"] == "video")
    audio = next(s for s in probe["streams"] if s["codec_type"] == "audio")
    profile = next(p["profile"] for p in result["state"]["phaseResults"] if "profile" in p)
    fps, frames = profile["fps"], profile["frames"]
    duration = max(c["startTime"] + c["duration"] for c in clips + tracks)
    assert frames == math.ceil(duration * fps - 1e-9)
    assert video["codec_name"] == "h264" and audio["codec_name"] == "aac"
    assert (video["width"], video["height"]) == (profile["width"], profile["height"])
    assert int(video["nb_read_frames"]) == frames
    assert abs(float(video["duration"]) - frames / fps) < 1 / fps
    assert abs(float(audio["duration"]) - duration) <= max(1 / fps, 1024 / 44100)
    assert abs(float(video.get("start_time", 0)) - float(audio.get("start_time", 0))) < 1 / fps
    assert audio["sample_rate"] == "44100" and audio["channels"] == 2
    assert len(output_bytes) <= 96 * 1048576
    # Decode both entire streams, not only the selected comparison frames.
    ffmpeg("-i", output, "-map", "0:v:0", "-map", "0:a:0", "-f", "null", "-")

    source_dir = folder / "sources"
    source_dir.mkdir()
    sources = {}
    source_for = {}
    source_frames = {}
    for item in clips + tracks:
        data = base64.b64decode(item["base64"], validate=True)
        identity = sha(data)
        source = source_dir / (identity + ".media")
        if identity not in sources:
            source.write_bytes(data)
            sources[identity] = source
            if item in clips:
                info = json.loads(run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(source)]))
                stream = next(s for s in info["streams"] if s["codec_type"] == "video")
                assert stream["avg_frame_rate"] == "24/1", "Reference picture sampling requires native 24-fps sources"
                source_frames[source] = int(stream["nb_frames"])
        source_for[item["id"]] = source

    width, height = 160, 90

    def source_frame(source, time):
        return min(source_frames[source]-1, max(0, math.floor((time + 1e-7) * 24)))

    def pictures(source, selected, fit=False):
        selected = sorted(selected)
        expression = '+'.join(f'eq(n\\,{frame})' for frame in selected)
        scale = f"scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black" if fit else f"scale={width}:{height}"
        data = ffmpeg("-i", source, "-frames:v", len(selected), "-vf", f"select={expression},{scale}",
                      "-vsync", "0", "-pix_fmt", "rgb24", "-f", "rawvideo", "-")
        size = width * height * 3
        assert len(data) == size * len(selected), f"Missing decoded comparison frames: {source}"
        return {frame:data[index*size:(index+1)*size] for index,frame in enumerate(selected)}

    def weight(index, time):
        clip = clips[index]
        start, end = clip["startTime"], clip["startTime"] + clip["duration"]
        if not start <= time < end:
            return 0
        value = 1
        if index:
            overlap = min(clip.get("transitionDuration", 0), clip["duration"], clips[index-1]["startTime"] + clips[index-1]["duration"] - start)
            if overlap > 0 and time < start + overlap:
                value = (time - start) / overlap
        if index + 1 < len(clips):
            after = clips[index+1]
            overlap = min(after.get("transitionDuration", 0), after["duration"], end - after["startTime"])
            if overlap > 0 and time >= after["startTime"]:
                value = min(value, 1 - (time - after["startTime"]) / overlap)
        return max(0, min(1, value))

    points = {0, frames - 1, frames // 2 - 1, frames // 2, frames // 2 + 1}
    for clip in clips:
        points.add(round((clip["startTime"] + clip["duration"] / 2) * fps))
        for time in (clip["startTime"], clip["startTime"] + clip.get("transitionDuration", 0) / 2,
                     clip["startTime"] + clip.get("transitionDuration", 0)):
            frame = math.ceil(time * fps - 1e-9)
            points.update((frame - 1, frame, frame + 1))
    points = sorted(p for p in points if 0 <= p < frames)
    wanted = {}
    for frame in points:
        time = frame / fps
        for index,clip in enumerate(clips):
            if weight(index,time):
                source = source_for[clip["id"]]
                wanted.setdefault(source,set()).add(source_frame(source,time-clip["startTime"]+clip.get("trimStart",0)))
    output_pictures = pictures(output,points)
    source_pictures = {source:pictures(source,selected,True) for source,selected in wanted.items()}
    comparisons, tiles = [], []
    for frame in points:
        time = frame / fps
        weights = [weight(i, time) for i in range(len(clips))]
        total = sum(weights)
        expected = [0.0] * (width * height * 3)
        for index, value in enumerate(weights):
            if not value:
                continue
            clip = clips[index]
            local = time - clip["startTime"] + clip.get("trimStart", 0)
            source = source_for[clip["id"]]
            data = source_pictures[source][source_frame(source,local)]
            for pixel, channel in enumerate(data):
                expected[pixel] += channel * value / total
        expected = bytes(round(v) for v in expected)
        actual = output_pictures[frame]
        assert len(actual) == len(expected)
        mse = sum((a-b)**2 for a, b in zip(actual, expected)) / len(actual)
        psnr = 99.0 if mse == 0 else 10 * math.log10(255**2 / mse)
        comparisons.append({"frame": frame, "time": time, "activeClips": [i for i,w in enumerate(weights) if w], "psnrDb": psnr})
        tiles.append((actual, expected))
    # Keep an actual/expected comparison sheet for visual inspection.
    columns, cell_width = 4, width * 2
    rows = math.ceil(len(tiles) / columns)
    sheet = bytearray(columns * cell_width * rows * height * 3)
    for i, pair in enumerate(tiles):
        for y in range(height):
            for half, image in enumerate(pair):
                offset = ((i // columns * height + y) * columns * cell_width + i % columns * cell_width + half * width) * 3
                sheet[offset:offset + width * 3] = image[y * width * 3:(y+1) * width * 3]
    ppm = folder / "comparisons.ppm"
    ppm.write_bytes(f"P6\n{columns*cell_width} {rows*height}\n255\n".encode() + sheet)
    ffmpeg("-i", ppm, "-frames:v", "1", folder / "comparisons.png")

    rate, channels = 44100, 2

    def pcm(source):
        data = array.array('f')
        data.frombytes(ffmpeg("-i", source, "-vn", "-ac", channels, "-ar", rate, "-f", "f32le", "-"))
        if sys.byteorder != "little":
            data.byteswap()
        return data

    audible = [c for c in clips if c.get("hasAudio") and not c.get("muted") and c.get("gain", 1) > 0] + [t for t in tracks if t.get("gain", 1) > 0]
    events = sorted([(item["startTime"], 1) for item in audible] + [(item["startTime"] + item["duration"], -1) for item in audible])
    active = overlap = 0
    for _, delta in events:
        active += delta
        overlap = max(overlap, active)
    headroom = 1 / max(1, overlap)
    expected_pcm = array.array('f', [0]) * (math.ceil(duration * rate) * channels)
    decoded = {}
    for item in audible:
        source = source_for[item["id"]]
        if source not in decoded:
            decoded[source] = pcm(source)
        data = decoded[source]
        start = round(item["startTime"] * rate) * channels
        trim = round(item.get("trimStart", 0) * rate) * channels
        count = min(round(item["duration"] * rate) * channels, len(data) - trim, len(expected_pcm) - start)
        gain = item.get("gain", 1) * headroom
        for index in range(max(0, count)):
            expected_pcm[start + index] += data[trim + index] * gain
    actual_pcm = pcm(output)
    audio_comparisons = []
    # Beginning/middle/end and every transition cover alignment and missing sound.
    times = sorted(set([1.0, duration/2, duration-1] + [c["startTime"] + .25 for c in clips[1:]]))
    for time in times:
        first, count = int(time * rate), int(.5 * rate)
        target = np.asarray(expected_pcm[first*channels:(first+count)*channels:channels],dtype=np.float64)
        observed = np.asarray(actual_pcm[first*channels:(first+count)*channels:channels],dtype=np.float64)
        energy = float(target @ target)
        rms = float(np.sqrt(np.mean(observed**2)))
        if math.sqrt(energy / len(target)) < 1e-4:
            audio_comparisons.append({"kind":"near-silence","time":time,"correlation":None,"rms":rms,"levelRatio":None,"offsetMs":None})
            continue
        radius = int(.08 * rate)
        nearby = np.asarray(actual_pcm[(first-radius)*channels:(first+count+radius)*channels:channels],dtype=np.float64)
        size = 1 << (len(nearby) + len(target) - 2).bit_length()
        dots = np.fft.irfft(np.fft.rfft(nearby,size) * np.fft.rfft(target[::-1],size),size)[len(target)-1:len(nearby)]
        sums = np.concatenate(([0.0],np.cumsum(nearby**2)))
        energies = sums[len(target):] - sums[:-len(target)]
        correlations = dots / np.sqrt(np.maximum(1e-30,energy * energies))
        best = int(np.argmax(correlations))
        audio_comparisons.append({"kind":"content","time":time,"correlation":float(correlations[best]),"rms":rms,
                                  "levelRatio":math.sqrt(max(0,float(energies[best]))/energy),"offsetMs":(best-radius)*1000/rate,
                                  "unalignedCorrelation":float(target @ observed / math.sqrt(max(1e-30,energy*float(observed@observed))))})
    failures = []
    if any(point["psnrDb"] < 24 for point in comparisons):
        failures.append("Selected picture/source comparison below fixed 24 dB PSNR threshold")
    if any((p["rms"] > .001 if p["kind"] == "near-silence" else p["correlation"] < .85 or not .8 <= p["levelRatio"] <= 1.2 or abs(p["offsetMs"]) > 1000/fps) for p in audio_comparisons):
        failures.append("Expected audio comparison outside fixed correlation/level thresholds")
    report = {"schemaVersion":1,"status":"failed" if failures else "passed","failures":failures,
              "inputSha256":sha(raw),"receivedSha256":sha(output_bytes),"sourceInputsSha256":result["sourceInputsSha256"],
              "scope":"Full decode plus selected independent source picture/PCM comparisons; human listening and physical targets unqualified",
              "duration":duration,"profile":profile,"streams":{"video":video,"audio":audio},"clipCount":len(clips),
              "thresholds":{"minimumPsnrDb":24,"minimumAudioCorrelation":.85,"audioLevelRatio":[.8,1.2],"maximumAudioOffsetMs":1000/fps,"nearSilenceExpectedRms":1e-4,"nearSilenceMaximumOutputRms":.001},
              "pictures":comparisons,"audio":{"headroom":headroom,"unmutedClips":len([c for c in clips if c in audible]),"comparisons":audio_comparisons},
              "versions":{"numpy":np.__version__,"ffmpeg":run(["ffmpeg","-version"]).decode().splitlines()[0],"ffprobe":run(["ffprobe","-version"]).decode().splitlines()[0]}}
    (folder / "inspection.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"status":report["status"],"pictures":len(comparisons),"minimumPsnrDb":min(p["psnrDb"] for p in comparisons),"audioWindows":len(audio_comparisons),"minimumCorrelation":min(p["correlation"] for p in audio_comparisons if p["correlation"] is not None),"failures":failures}))
    return not failures


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python3 scripts/inspect-reference.py input.json ignored-run-directory")
    raise SystemExit(0 if inspect(*sys.argv[1:]) else 1)
