# Support and limits

ClipBraid is an experimental, laptop-first editor. Use a secure site (HTTPS or
localhost), a Chromium browser with WebCodecs AVC encoding, and a small project
first. A browser accepting a file does not establish that every codec or project
will export on that device.

| Target | Evidence available | Support boundary |
| --- | --- | --- |
| Linux x86_64, pinned Chromium 153.0.8010.12, GPU/video acceleration disabled | Automated media/recovery cases and the 23-clip reference at Draft/Standard, including a repeat and native-audio variant | This software test environment only; it is not a physical-device or performance guarantee |
| Physical desktop Chrome | Automated desktop-sized layouts and keyboard cases | Complete physical microphone/storage/device qualification is pending |
| Android and Flow WebView | Adapter-contract and emulated viewport cases | Real Android/Flow device qualification is pending; emulation does not establish host support |
| Other browser/OS combinations | No complete qualification record | Unqualified; codec or API availability may prevent export |

No general hardware-acceleration claim is made. **Compatibility render (one
encoder)** reduces simultaneous encoder demand. It does not guarantee sufficient
memory, codec support, or final file delivery.

## Output profiles

| Profile | Landscape / portrait / square | Target video bitrate |
| --- | --- | --- |
| Draft | 854×480 / 480×854 / 480×480 | 0.5 Mbit/s |
| Standard | 1280×720 / 720×1280 / 720×720 | 2 Mbit/s |
| High | Same dimensions as Standard | 4 Mbit/s |

Output is re-encoded AVC video and stereo AAC at 44.1 kHz with a 192 kbit/s audio
target. The highest source frame rate is limited to 12–30 output frames per
second; common fractional rates are retained. Variable-rate or mixed-rate media
is sampled onto that constant output grid. Still-only projects use 30 fps.
The output uses square pixels and browser-managed SDR sRGB conversion. HDR and
unusual codecs/color formats are not broadly qualified and may be rejected.
Resizing, re-encoding, rate conversion and framing can change the source picture;
this is not lossless or archival output.

Size estimates use target bitrates and container allowance; actual size varies.
Video handoff is capped at 96 MiB, with potentially lower host limits. High can
make a larger file without increasing resolution. Draft and a shorter project
can reduce memory/output demand. No universal duration or clip-count limit has
been qualified across devices.

## Projects, storage and sources

The project reader rejects documents above 256 MiB and has a 256 MiB decoded
media budget. These are validation ceilings, not safe device-memory limits.
Embedded base64 increases project size. Local recovery keeps at most two committed
revisions within a 128 MiB budget; quota or persistence denial can prevent saving.
Check the visible storage status rather than assuming a revision exists.

Imports keep original sources. **Optimize previews** creates separate playback
copies and does not replace exported originals or restore already damaged legacy
sources. Keep a downloaded project and the original files. Browser storage can
be evicted or cleared, and a different origin/profile cannot read it automatically.

## Networking and host actions

Media processing runs in your browser. Page assets, fonts and icons are included
with the app. By default the media-tool core is fetched from pinned
`@ffmpeg/core@0.12.6` locations on unpkg/jsDelivr. Those requests contact external
services. Hosts can supply their own file picker, microphone and save/download
integration; their permissions, transport and storage behavior belong to that host.

Microphone recording needs browser/host permission and supported recording APIs.
Cancel and early stop depend on explicit host hooks. If unavailable, record
externally and import an audio file. Physical permission behavior remains unqualified.

A site operator can self-host the pinned UMD `ffmpeg-core.js` and
`ffmpeg-core.wasm` files and set `window.CLIPBRAID_FFMPEG_CORE_BASE_URL` before
the app module loads, as shown in the [README](../README.md#get-started).
With that setting, only the configured core directory is used. Self-hosting
removes the external core dependency, but the app/core assets must still be
reachable; it does not install an offline app or guarantee browser persistence.

**Download started** records browser initiation; **Host accepted** records host
acknowledgement. Verify the file in its actual destination. If an outcome is
unknown, check there before retrying to avoid duplicate copies.

For a problem report, include the browser/OS, selected profile, observed behavior
and copied job summary from **Details → Export history**. The copied summary
omits media filenames/paths/payloads. Keep project/media files private unless you
choose to share them separately. No universal privacy, backup or delivery guarantee
is implied by local processing.

[Editing and recovery](using-clipbraid.md) · [Upgrading and legacy projects](upgrading.md)
