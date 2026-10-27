# Upgrading and older projects

Before an upgrade, choose **Save project**, verify the JSON file reached your
downloads or host, and keep the original source media. Keep a copy of that JSON
before resaving it in a newer editor.

Current projects write format version 2. Unversioned RED VOX drafts and version 1
projects remain readable. The old product name in a legacy file does not make it
invalid. A loaded project keeps its chosen basename when saved; unsafe filename
characters are sanitized. Existing machine identifiers and 2.x readers remain
compatible. The visible ClipBraid name does not require renaming your files.

Open an older project with **Open project**, check clips and sound choices,
then save a new copy. Invalid or unsupported project files are rejected while
the current project stays available. If an older editor already replaced a
source with a silent/low-resolution copy, that file cannot recover the lost
original. Select the affected video and **Relink original video** using your
original source, then check trims and native sound.

Keep the same site origin when upgrading. Browser local revisions and diagnostic
history belong to that origin and browser profile. Moving to another domain,
scheme or port does not transfer them. Save a project file before moving, then
open it at the new site. Do not clear the old site's storage until you have
verified the new copy.

If an upgrade fails, retain your downloaded project and originals, reopen the
previous site/build at its existing origin, and check the project before editing.
Older releases may not read a newer schema; use your pre-upgrade backup rather
than overwriting the only copy. Site operators should preserve a prior build and
test cached-page refresh, core asset versions and host handoffs before rollout.

[Editing, save/export and recovery](using-clipbraid.md) · [Support and limits](support.md)
