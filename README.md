# Viscanon Foundry module 0.2.2 receive-window candidate

This candidate preserves the 0.1.4 pairing and artwork receiver. It adds GM-only **Send to Foundry** requests for sharing artwork, placing map pins, creating scenes, and attaching artwork to actors. It has not been published or tested in a real Foundry world yet.

## Install and connect

Install the module from the stable manifest URL so Foundry's normal **Update** button can install later releases:

```text
https://foundry.viscanon.com/module.json
```

Enable **Viscanon** in the world, then open **Configure Settings > Viscanon** as GM. Paste the campaign artwork connection code as before. Viscanon reveals and shared memories continue to open native image windows for everyone in the world.

For Send to Foundry, create a **GM workspace code** in the same Viscanon campaign and paste it into the new field. This second code is saved only in that GM's browser, not as a world setting or in module socket messages. Each GM browser that may become the active GM needs its own saved copy. The browser's workspace status shows whether this connection is active. Keep the code private and clear it from a shared browser.

When Viscanon sends an entry, the active GM gets a Foundry popup with four actions:

- **Reveal artwork** copies the image to Foundry storage and shares a native Image Popout with connected players. It does not change Viscanon's reveal state.
- **Place map pin** lets the GM choose a scene and click a location. The transparent Viscanon eye is linked to an image Journal. **Will appear on reveal** starts GM-only and becomes player-visible after a Viscanon reveal or this popup's local artwork reveal. **GM only** stays hidden. **Visible to players** exposes it immediately with a public or generic title.
- **Create scene** uses the battlemap image when available, otherwise the entry image. The scene uses its actual image dimensions, a gridless canvas, and a black background. It starts inactive and GM-only.
- **Attach to actor** searches existing world actors or creates a new actor using a type supported by the game system. Existing player-visible actors require an explicit visibility choice before unrevealed artwork can be attached. A new actor starts GM-only.

Unrevealed pins and private scenes and actors stay in the neutral **Viscanon** root folder. Pins that the GM explicitly makes visible, or that a fresh Viscanon reveal authorizes, are grouped under neutral **Section** and **Group** folders keyed from stable chapter and entry-category identifiers. Folder names contain neither private titles nor raw Viscanon IDs. This preserves the chapter/category structure for exposed pins, including renames and GM failover, but private document nesting still needs a real player-account test of Foundry folder visibility and metadata. Player-visible pins use the neutral title **Viscanon artwork**; a GM may rename a visible Journal manually.

Artwork is downloaded from a Viscanon-approved URL into the GM browser's memory when the popup opens because Supabase signed URLs expire. Closing without an action creates no stored file. **Foundry persistent artwork files are public to anyone who can fetch their URLs; random filenames do not make them private.** GM-only and on-reveal pins therefore start with the module's public eye icon and do not upload unrevealed artwork. A matching Viscanon reveal triggers a fresh server authorization check, then uploads the artwork and opens the pin to players. An explicit Reveal, visible pin, scene, or actor action also publishes the chosen artwork file; the popup explains this before saving. Undo hides a matching on-reveal Journal but cannot make an already uploaded Foundry file private again. A failed download or upload is shown in the popup; retry while its link remains valid. Player FilePicker browsing and direct requests to known paths remain publication-blocking world tests.

**Will appear on reveal** pins are checked against the current Viscanon artwork and shared card while the GM workspace is connected. A matching reveal makes the Journal visible; Undo or replacing the artwork hides it again. The checks catch up after the active GM reconnects. A Foundry-local **Reveal artwork** is an explicit player share in this world and keeps matching pins visible even if the Viscanon reveal is later undone. **Visible to players** pins remain visible until the GM changes or removes them; **GM only** pins remain hidden. A Sent/received indication in Viscanon means the GM popup opened, not that the GM chose an action. Send requires an unconsumed four-second receive window. The response must pass the current-window check before that window ends, and the GM must acknowledge the popup within five seconds of Send. A Send near the end of a window may fail visibly even while the GM is connected. A later receive request cannot replay an unfinished command, even in the same receiver session. An interruption that the original request does not observe can still deliver within those deadlines if its response reaches the GM after the network resumes. A lost acknowledgment can leave the sender uncertain after the popup opened. Test these network races in a real world before release.

## Compatibility

The manifest declares Foundry 13 through 14. Scene artwork uses v13's `background.src` or v14's `levels[].background.src`. Map pins use Foundry Notes linked to Journal image pages. The native `ImagePopout.shareImage` API broadcasts artwork. The existing test world was Foundry 14 build 364 with DnD5e 5.3.3, but this **0.2.2 candidate has not been accepted there**. Foundry 13 acceptance is pending. Run the manual checklist in the release handoff before publishing.

## Build an install ZIP

Use Node.js 24 or newer and Python 3. The deterministic packager writes only the allowlisted module files into a `viscanon-bridge/` directory in the archive:

```sh
node package.mjs /absolute/output/viscanon-bridge.zip
```

Keep the module's `manifest` field at the stable URL. A release must upload the exact ZIP referenced by `download`, publish the matching stable manifest only after review, and verify Foundry's Update path. The old 0.1.4 ZIP and live stable manifest remain the rollback target until acceptance.
