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

## Make a video

1. **Add visuals** to put video clips and photos on the timeline.
2. **Add audio** to choose one or more files. Files chosen together start at the
   playhead on separate, parallel tracks.
3. Turn **Original video sound** off for your own soundtrack, or select a clip
   to adjust its sound, trim, order and look.
4. **Save project** keeps an editable JSON draft. **Export video** prepares an MP4.

This is an experimental editor. Picture/sound fidelity and recovery issues remain,
and long exports can stall. Size targets are estimates; browser/device support
varies. Keep original files and save drafts regularly; autosave and undo are not
available yet. Existing JSON project files remain readable.

## Checks

```bash
npx --no-install playwright install --with-deps chromium
npm run check
npm run audit:dependencies
```

The bounded suite includes explicit known-failure cases for unresolved behavior.
A green result does not establish complete media, device or delivery qualification.

## License

Project source and original artwork are [MIT licensed](LICENSE).
Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
