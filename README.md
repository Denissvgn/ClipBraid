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
4. **Save project** keeps an editable JSON draft. **Export video** prepares an MP4.

Track volumes share the same overlap headroom in preview and export. New project
files use format version 2; unversioned and version 1 drafts remain readable.

Exports are resized/re-encoded to the chosen 480p/720p profile at up to 30 fps SDR.
File sizes are advisory bitrate estimates; video handoff is capped at 96 MiB and
host limits may be lower. Browser delivery reports download initiation.

Local autosave offers browser revision recovery. Keep originals and download a
separate project backup; browser storage can be removed externally. Undo is not
available yet. The browser recorder supports early stop and cancel; host recording
requires explicit stop/cancel hooks. Unsupported host capabilities are reported.

This is an experimental editor. Physical browser/device/Flow support and broader
media qualification remain in progress.

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
