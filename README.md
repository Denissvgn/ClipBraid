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

1. **Add visuals** to choose one video or photo; repeat for each item.
2. **Add audio** to choose one or more files. Files chosen together start at the
   playhead on separate, parallel tracks.
3. Turn **Original video sound** off for your own soundtrack, or select a clip
   to adjust its sound, trim, order and look.
4. **Save project** downloads an editable JSON file containing your media and edits.
   **Export video** makes an MP4 to watch or share. **Open project** loads a JSON
   project; **Restore local revision** recovers a browser autosave.

Track volumes share the same overlap headroom in preview and export. Output is
re-encoded to 480p/720p at up to 30 fps SDR. File sizes are estimates; check your
actual downloads or host storage after handoff. This is an experimental editor;
physical device and Flow support is still being tested.

- [Editing, project backups, export and recovery](guides/using-clipbraid.md)
- [Browser support, profiles, storage and networking](guides/support.md)
- [Upgrading and older RED VOX projects](guides/upgrading.md)

## Checks

```bash
npx --no-install playwright install --with-deps chromium
npm run check
npm run audit:dependencies
```

The bounded suite checks media regressions, worker failures and production isolation.
A green result does not establish complete media, device or delivery qualification.
Required checks use the pinned npm packages and Chromium; native `ffmpeg` and
`ffprobe` commands are optional independent inspection tools. Regenerating the
[synthetic fixtures](scripts/generate-fixtures.py) additionally requires Python 3
and native FFmpeg with the features listed in that script. Review changed fixture
hashes before accepting a regenerated inventory.

## License

Project source and original artwork are [MIT licensed](LICENSE).
Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
