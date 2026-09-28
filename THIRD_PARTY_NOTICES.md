# Third-party notices

ClipBraid's own source is licensed under the [MIT license](LICENSE). That grant
does not replace the licenses of its dependencies, fonts, icons or codecs.

| Component | Version in this source snapshot | Upstream license / source |
| --- | --- | --- |
| Geist, Space Grotesk, JetBrains Mono font files | Fontsource Variable 5.3.0 | SIL Open Font License 1.1; retained notices in [licenses/](licenses/) |
| Lucide icons | 1.48.0 | ISC; [upstream license](https://github.com/lucide-icons/lucide/blob/main/LICENSE) |
| Mediabunny and its AC3 package | 1.58.1 | MPL-2.0; notices supplied in the locked npm packages |
| React / React DOM | See package-lock.json | MIT; upstream notices supplied in the npm packages |
| FFmpeg WASM core | 0.12.6 | The compiled core follows FFmpeg and its included libraries' licenses; the package metadata is not a complete binary-license inventory. [Upstream explanation](https://ffmpegwasm.netlify.app/docs/faq/#what-is-the-license-of-ffmpegwasm) |

The fonts are served from the app bundle. Icon SVG components come from Lucide;
the ClipBraid braid mark is original project artwork. FFmpeg is loaded at runtime.
Keep applicable upstream notices when distributing a built application. The
lockfile identifies exact package versions. Package license labels do not replace
review of the actual compiled codecs and their upstream notices.
