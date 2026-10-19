# Viscanon Foundry module development source

Viscanon 0.2.7 gives players scene labels without the GM's scene-number prefix, opens newly created scenes in the initiating GM's view, and names new actors after their current Viscanon entry. The four workspace cards have equal heights, with Pin visibility directly above its dropdown. Existing actor names, document permissions, and other users' views are preserved. This module-only release uses the existing backend and database. Real Foundry 14 GM and player acceptance remains user testing.

## Install and connect

Install the module from the stable manifest URL so Foundry's normal **Update** button can install later releases:

```text
https://foundry.viscanon.com/module.json
```

Enable **Viscanon** in the world, then open **Configure Settings > Viscanon** as GM. Create one Foundry connection code in Viscanon Campaign Settings and paste it into the single Foundry field. The code starts with `VC2-` and contains two independent capabilities: the artwork read half is saved as a world setting for shared reveals, while the Send half is saved only in this GM account's browser. The full code and private Send half are never saved in world settings or sent over Foundry sockets. Switching Foundry accounts clears the private half. Each GM browser that may become active must pair with a current code. A legacy 64-character code still receives artwork but cannot by itself enable Send to Foundry.

When Viscanon sends an entry, the active GM gets a Foundry popup with four actions:

- **Reveal artwork** reveals the canonical artwork in Viscanon, then sends that same authorized reveal event to connected Foundry players. The existing receivers deduplicate concurrent polling and socket delivery. Failure to confirm the backend reveal does not produce a local-only share.
- **Place map pin** uses the currently viewed scene and attaches a preview to the cursor until the GM clicks. Escape, right-click, closing the popup, changing scenes, or losing GM authority cancels placement. The transparent Viscanon eye is linked to an image Journal. **Will appear on reveal** starts GM-only and becomes player-visible after a Viscanon reveal or this popup's local artwork reveal. **GM only** stays hidden. **Visible to players** exposes it immediately with a public or generic title.
- **Create scene** uses the artwork displayed in the popup. The scene uses its actual image dimensions, a gridless canvas, and a black background. It starts inactive and GM-only.
- **Attach to actor** searches existing world actors or creates a new actor using a type supported by the game system. Existing player-visible actors require the artwork to be currently revealed in Viscanon. The action rechecks this before upload and before updating only the portrait; ownership, tokens, and other actor data remain unchanged. A new actor starts GM-only.

Unrevealed pins and private scenes and actors stay in the neutral **Viscanon** root folder. Pins that the GM explicitly makes visible, or that a fresh Viscanon reveal authorizes, are grouped under neutral **Section** and **Group** folders keyed from stable chapter and entry-category identifiers. Folder names contain neither private titles nor raw Viscanon IDs. This preserves the chapter/category structure for exposed pins, including renames and GM failover, but private document nesting still needs a real player-account test of Foundry folder visibility and metadata. Player-visible pins use the neutral title **Viscanon artwork**; a GM may rename a visible Journal manually.

Artwork is downloaded from a Viscanon-approved URL into the GM browser's memory when the popup opens because Supabase signed URLs expire. Closing without an action creates no stored file. **Foundry persistent artwork files are public to anyone who can fetch their URLs; random filenames do not make them private.** GM-only and on-reveal pins therefore start with the module's public eye icon and do not upload unrevealed artwork. A matching Viscanon reveal triggers a fresh server authorization check, then uploads the artwork and opens the pin to players. An explicit visible pin, scene, or actor action also publishes the chosen artwork file; selecting the action authorizes this file upload. Undo hides a matching on-reveal Journal but cannot make an already uploaded Foundry file private again. A failed download or upload is shown in the popup; retry while its link remains valid. Player FilePicker browsing and direct requests to known paths remain part of the pending GM/player world acceptance.

**Will appear on reveal** pins are checked against the current Viscanon artwork and shared card while the GM receiver is connected. A matching reveal makes the Journal visible; Undo or replacing the artwork hides it again. The checks catch up after the active GM reconnects. The popup’s **Reveal artwork** follows the same Viscanon reveal and Undo rules. Historical pins marked as locally revealed by older modules retain their existing visibility behavior. **Visible to players** pins remain visible until the GM changes or removes them; **GM only** pins remain hidden. A Sent/received indication in Viscanon means the GM popup opened, not that the GM chose an action. Send requires an unconsumed four-second receive window. The response must pass the current-window check before that window ends, and the GM must acknowledge the popup within five seconds of Send. A Send near the end of a window may fail visibly even while the GM is connected. A later receive request cannot replay an unfinished command, even in the same receiver session. An interruption that the original request does not observe can still deliver within those deadlines if its response reaches the GM after the network resumes. A lost acknowledgment can leave the sender uncertain after the popup opened. Test these network races in a real world before release.

## Compatibility

The manifest declares Foundry 14, preserving the currently published compatibility scope. Scene artwork uses v13's `background.src` or v14's `levels[].background.src`. Map pins use Foundry Notes linked to Journal image pages. The native `ImagePopout.shareImage` API broadcasts artwork. The existing test world was Foundry 14 build 364 with DnD5e 5.3.3, but the unified-pairing follow-up has not been accepted there. Run the manual checklist in the release handoff during GM/player world acceptance.

## Build an install ZIP

Use Node.js 24 or newer and Python 3. The deterministic packager writes only the allowlisted module files into a `viscanon-bridge/` directory in the archive:

```sh
node package.mjs /absolute/output/viscanon-bridge.zip
```

Keep the module's `manifest` field at the stable URL. A follow-up release must upload the exact ZIP referenced by `download`, publish the matching stable manifest only after review, and verify Foundry's Update path. Keep the published 0.2.3 ZIP and manifest intact as rollback evidence.

Hidden pin artwork opens in a GM-only local blob Image Popout after fresh authorization, without a public upload. Each hidden Journal persists only its campaign ID, entry ID, and artwork fingerprint. Opening it retrieves fresh artwork through the currently authorized GM receiver; reconnect, browser reload, and world restart do not require a new Send or pin replacement. A changed artwork fingerprint fails closed. Older on-reveal pins already contain the required identity. Older GM-only pins without entry identity remain unchanged and are never guessed or silently linked. The Link existing pin control has been removed. No credentials, signed URLs, or private titles are stored in flags. Native public pin behavior and reveal reconciliation remain in place.

New pin Journal/page names and new Scene names use the authoritative entry name; scene entries include their actual scene number when present. Names are not copied into Note text or identity flags. GM-only and on-reveal pins retain private ownership and placeholder image pages until authorized publication. Existing document names and Scene organization are not migrated. New Scenes use an existing Viscanon root when available, then their chapter (when present), then Locations, Characters, or Scenes. Actor selection and attachment remain available without a search field.

### 0.2.7 scene names, local view, and workspace feedback

New scenes retain the scene-number prefix for GM organization and set Foundry's native navigation name to the entry name without that prefix. For new marked scenes and scene-entry pin journals/pages, the module prepares the player document name without the recorded prefix, covering directory labels, automatic document links, sheet titles, and page labels in addition to navigation. Custom navigation names and document names without that exact prefix are preserved. This is a client-side presentation rule, not a secrecy boundary for document source data or a rewrite of explicit labels authored in chat/journals. It requires this module to remain enabled. Existing scenes and pins lack the new marker and are not migrated or renamed; their current names and custom navigation names remain unchanged.

Create scene opens the new scene for the initiating active GM using `Scene.view()`. It leaves world activation, other users' views, navigation visibility, and ownership unchanged. Repeated clicks in the same popup reuse the created scene; a view failure reports that creation succeeded and allows a view retry.

New actors use the current entry name, without scene numbering or artwork revision names. Attaching artwork to an existing actor changes only its portrait. The four workspace action cards use equal-height rows, and Pin visibility sits directly above its dropdown beside the larger icon preview.
