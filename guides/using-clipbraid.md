# Make and keep a video project

ClipBraid combines video clips and photos with parallel audio. Start with a small
project on a laptop, keep the source files, and save an editable project as you work.
The editor is experimental; read the [support and limits](support.md) before a large job.

## Start and edit

1. Choose **Start editing**, then **Add visuals** and select one video or photo.
   Repeat **Add visuals** for each remaining item. Imports keep the original media; preview optimization creates
   separate copies for playback.
2. Select a clip on the timeline. Its settings let you trim the beginning/end,
   change its look, use **Earlier**/**Later**, remove it, or adjust original sound.
   Close **Clip settings** to return to project settings.
3. Choose an aspect ratio. **Fit whole image** keeps the whole image with black margins;
   **Fill frame** crops it to fill the frame. Preview framing guides are editing aids.
4. Set visual crossfades where wanted. Check the cut or overlap in preview;
   a visual fade does not mute the underlying original audio.
5. Put the playhead where sound should start and choose **Add audio**. Files
   selected together start there on separate, parallel tracks. Adjust each track's
   volume in **Audio levels**. The timeline shows where tracks end.
6. Use **Original video sound** to turn all original clip sound on/off, or choose
   a clip and change **Original clip sound** and **Original clip volume**.

Preview and export apply the same constant overlap headroom to the configured
track volumes. More simultaneous sound sources can make the whole mix quieter.
An overload error asks you to reduce a volume; the editor does not silently clip it.
An audio track extending past the last visual produces a black video tail.

## Save an editable project or export a video

| Action | Result | Use it for |
| --- | --- | --- |
| **Save project** | JSON containing media and edits | Continue editing, move work to another browser/site, keep a backup |
| **Open project** | Loads a saved JSON project | Reopen your editable work |
| **Export video** | Re-encoded MP4 | Watch or share the finished video |

After saving a project, check that the JSON reached your downloads or host file
location. Open it once to confirm the backup. An MP4 cannot restore the timeline.
ClipBraid has no undo/redo yet; save a separate project before a large edit.

Choose **Draft**, **Standard** or **High** in the project settings and review
**Export profile details**. Draft is smaller 480p output; Standard is 720p; High
uses the same 720p dimensions with a higher bitrate. [Profile details and limits](support.md#output-profiles).
Keep the page open through rendering and file handoff. **Cancel export** stops
processing while cancellation is available. During file handoff, wait for its
result and check the destination before trying again.

**Download started** means the browser initiated a download. **Host accepted**
means the embedded host acknowledged a handoff. Check the actual destination;
neither message guarantees final device storage.

## Recover and retry

- If **Local recovery available** appears, **Restore local revision** loads the
  last committed browser revision. **Keep current project** leaves your current
  work in place. Save the current project first when you need both versions.
- **Saved locally** is device/site-local recovery, not an external backup.
  Storage can be denied, cleared, or evicted. Keep a downloaded project and originals.
- A corrupt visual or audio error identifies the failing item. Use **Inspect clip**
  or **Inspect audio track**, replace/remove that source, and retry the current project.
  If the source was replaced since the failed export, inspect the current project.
- For overload, choose **Review audio levels** and lower a volume. For codec or
  memory errors, try Draft or **Compatibility render (one encoder)**. Split a large
  project if needed; these options do not guarantee a device can handle it.
- If media tools fail to load, use the offered retry after checking connectivity.
  A self-hosted pinned core is an option for the site operator.
- If delivery is unknown, check downloads/host storage first. A retry could create
  another copy. If cleanup fails, save your project and reload when instructed.

**Details → Export history** shows current and retained job summaries. Copy the
summary when reporting a problem; it contains technical IDs/outcomes and omits
media filenames, paths and payloads. Browser retention is best-effort. The clear
history action removes those summaries, not your downloaded projects.

Use Tab/Shift+Tab to reach buttons and settings, Enter/Space to activate them,
and arrow keys on sliders. Escape closes dialogs. On a narrow screen, scroll
through the project/clip settings; closing a dialog returns focus to its opener.

[Upgrading and older projects](upgrading.md) · [Support, networking and limits](support.md)
