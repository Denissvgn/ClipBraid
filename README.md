# ClipBraid — your clips, your sound

A laptop-first browser editor for combining video clips and photos with your own
soundtrack. Import several audio files in parallel and turn original video sound
on or off, globally or per clip.

## Get started

Use Node 22.23.3 and npm 11.11.1.

```bash
npm ci
npm run dev       # http://localhost:5173
npm run build     # production files in dist/
npm run preview
```

Export requires HTTPS or localhost and a browser with WebCodecs AVC support.
Fonts and icons are included; the FFmpeg core downloads from an external service.
To host that core yourself, serve the UMD `ffmpeg-core.js` and `ffmpeg-core.wasm`
from pinned `@ffmpeg/core@0.12.6` and set
`window.CLIPBRAID_FFMPEG_CORE_BASE_URL = "/your-core-directory"` before loading
the app module. This option uses only that directory; media-tool failures can
be retried in the editor.

## Make a video

1. **Add visuals** to put video clips and photos on the timeline.
2. **Add audio** to choose one or more files. Files chosen together start at the
   playhead on separate, parallel tracks.
3. Turn **Original video sound** off for your own soundtrack, or select a clip
   to adjust its sound, trim, order and look.
4. **Save project** downloads an editable JSON file containing your media and edits.
   **Export video** makes an MP4 to watch or share. **Open project** loads a JSON
   project; **Restore local revision** recovers a browser autosave.

Track volumes share the same overlap headroom in preview and export. New project
files use format version 2; unversioned RED VOX and version 1 drafts remain
readable. A loaded project keeps its chosen basename when saved; unsafe filename
characters are sanitized. These readers
and existing developer-tool identifiers remain compatible throughout the 2.x line.

Exports are resized/re-encoded to the chosen 480p/720p profile at up to 30 fps SDR.
File sizes are advisory bitrate estimates; video handoff is capped at 96 MiB and
host limits may be lower. **Download started** means the browser initiated a
download; check your downloads for the saved file. **Host accepted** means the
embedded host acknowledged the handoff. Final device storage belongs to that
browser or host.

Local autosave offers browser revision recovery. Keep originals and download a
separate project backup; browser storage can be removed externally. Undo is not
available yet. The browser recorder supports early stop and cancel; host recording
requires explicit stop/cancel hooks. Unsupported host capabilities are reported.
Keep the same site origin when upgrading to retain local revisions. Download a
project file before moving to another host or domain; open that file on the new site.

This is an experimental editor. Physical browser/device/Flow support and broader
media qualification remain in progress.

Media processing runs in your browser. Embedded-host file selection, recording,
and save/download actions use that host’s integration. Export summaries stay in
this browser; copied summaries omit filenames, paths and media. **Details → Export
history** provides these summaries and a clear-history action.

## Checks

```bash
npx --no-install playwright install --with-deps chromium
npm run check
npm run audit:dependencies
```

The bounded suite checks media regressions, worker failures and production isolation.
A green result does not establish complete media, device or delivery qualification.

## License

Project source and original artwork are [MIT licensed](LICENSE).
Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
