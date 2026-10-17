# Viscanon 0.2.3 for Foundry 14

This release preserves the artwork receiver and adds GM-only **Send to Foundry** requests for sharing artwork, placing map pins, creating scenes, and attaching artwork to actors. Version 0.2.3 adds staged unified pairing. Send features require the matching Viscanon app and backend release. The owner’s in-world GM and player acceptance is pending.

## Install and connect

Install the module from the stable manifest URL so Foundry's normal **Update** button can install later releases:

```text
https://foundry.viscanon.com/module.json
```

Enable **Viscanon** in the world, then open **Configure Settings > Viscanon** as GM. Create one Foundry connection code in Viscanon Campaign Settings and paste it into the single Foundry field. The code starts with `VC2-` and contains two independent capabilities: the artwork read half is saved as a world setting for shared reveals, while the Send half is saved only in this GM account's browser. The full code and private Send half are never saved in world settings or sent over Foundry sockets. Switching Foundry accounts clears the private half. Each GM browser that may become active must pair with a current code. A legacy 64-character code still receives artwork but cannot by itself enable Send to Foundry.

When Viscanon sends an entry, the active GM gets a Foundry popup with four actions:

- **Reveal artwork** copies the image to Foundry storage and shares a native Image Popout with connected players. It does not change Viscanon's reveal state.
- **Place map pin** lets the GM choose a scene and click a location. The transparent Viscanon eye is linked to an image Journal. **Will appear on reveal** starts GM-only and becomes player-visible after a Viscanon reveal or this popup's local artwork reveal. **GM only** stays hidden. **Visible to players** exposes it immediately with a public or generic title.
- **Create scene** uses the battlemap image when available, otherwise the entry image. The scene uses its actual image dimensions, a gridless canvas, and a black background. It starts inactive and GM-only.
- **Attach to actor** searches existing world actors or creates a new actor using a type supported by the game system. Existing player-visible actors require an explicit visibility choice before unrevealed artwork can be attached. A new actor starts GM-only.

Unrevealed pins and private scenes and actors stay in the neutral **Viscanon** root folder. Pins that the GM explicitly makes visible, or that a fresh Viscanon reveal authorizes, are grouped under neutral **Section** and **Group** folders keyed from stable chapter and entry-category identifiers. Folder names contain neither private titles nor raw Viscanon IDs. This preserves the chapter/category structure for exposed pins, including renames and GM failover, but private document nesting still needs a real player-account test of Foundry folder visibility and metadata. Player-visible pins use the neutral title **Viscanon artwork**; a GM may rename a visible Journal manually.

Artwork is downloaded from a Viscanon-approved URL into the GM browser's memory when the popup opens because Supabase signed URLs expire. Closing without an action creates no stored file. **Foundry persistent artwork files are public to anyone who can fetch their URLs; random filenames do not make them private.** GM-only and on-reveal pins therefore start with the module's public eye icon and do not upload unrevealed artwork. A matching Viscanon reveal triggers a fresh server authorization check, then uploads the artwork and opens the pin to players. An explicit Reveal, visible pin, scene, or actor action also publishes the chosen artwork file; the popup explains this before saving. Undo hides a matching on-reveal Journal but cannot make an already uploaded Foundry file private again. A failed download or upload is shown in the popup; retry while its link remains valid. The owner will check player FilePicker browsing and direct requests to known paths in the post-release GM/player acceptance run.

**Will appear on reveal** pins are checked against the current Viscanon artwork and shared card while the GM receiver is connected. A matching reveal makes the Journal visible; Undo or replacing the artwork hides it again. The checks catch up after the active GM reconnects. A Foundry-local **Reveal artwork** is an explicit player share in this world and keeps matching pins visible even if the Viscanon reveal is later undone. **Visible to players** pins remain visible until the GM changes or removes them; **GM only** pins remain hidden. A Sent/received indication in Viscanon means the GM popup opened, not that the GM chose an action. Send requires an unconsumed four-second receive window. The response must pass the current-window check before that window ends, and the GM must acknowledge the popup within five seconds of Send. A Send near the end of a window may fail visibly even while the GM is connected. A later receive request cannot replay an unfinished command, even in the same receiver session. An interruption that the original request does not observe can still deliver within those deadlines if its response reaches the GM after the network resumes. A lost acknowledgment can leave the sender uncertain after the popup opened. The owner will test these network races in a real world during post-release acceptance.

## Compatibility

The manifest declares Foundry 14 only. Scene artwork uses v14's `levels[].background.src`. Map pins use Foundry Notes linked to Journal image pages. The native `ImagePopout.shareImage` API broadcasts artwork. The owner’s Foundry 14 GM and player acceptance remains to be recorded after deployment. The published 0.2.2 ZIP and manifest remain available for Foundry 13 users.

## Build an install ZIP

Use Node.js 24 or newer and Python 3. The deterministic packager writes the manifest, this README, and every file under the module runtime directories (`scripts`, `styles`, `assets`, `templates`, `lang`, and `fonts`) into a `viscanon-bridge/` directory in the archive. Git metadata, tests, and release tooling are excluded:

```sh
node package.mjs /absolute/output/viscanon-bridge.zip
```

The module's `manifest` field stays at `https://foundry.viscanon.com/module.json`; `download` names this version's immutable ZIP. The release workflow stages versioned ZIP and manifest assets from a reviewed branch and verifies their bytes before the stable manifest advances. When the same source reaches `main`, it compares the existing assets byte for byte and never replaces them. Keep the published 0.2.2 assets intact as rollback evidence.
