# Viscanon 0.1.4

Reveal artwork or share a memory in Viscanon, and it opens as a native image window for everyone connected to your Foundry world. GMs and players share memories using Viscanon’s existing controls. The module receives only artwork the campaign currently permits them to share.

Version 0.1.4 gives a connected world a subtle green status and a checkmark. Viscanon artwork opens without surrounding content padding or image margins, keeping the native titlebar, resizing and full image aspect ratio. The browser connection fix from 0.1.3 is retained.

## Installation

In Foundry’s Setup screen, open **Add-on Modules > Install Module**, paste this URL into **Manifest URL**, and click **Install**:

```text
https://foundry.viscanon.com/module.json
```

Open your world as GM and enable **Viscanon** in **Manage Modules**. The stable manifest URL lets Foundry check for future updates. Each manifest points to its own versioned install ZIP.

For a manual installation, extract the release ZIP so `viscanon-bridge/module.json` is inside Foundry’s `Data/modules` folder. Restart Foundry, then enable the module in the world.

## Connect your campaign

In Viscanon, open the campaign’s settings and create a Foundry connection code. In Foundry, open **Configure Settings > Viscanon > Connect to Viscanon**, paste the code, and click **Connect**. No Viscanon login is needed inside Foundry. Reveal an entry or share a memory in Viscanon to show its artwork.

Keep at least one GM connected to Foundry. The active GM receives new events every three seconds and forwards their IDs to other clients. Every client checks the event with Viscanon before showing artwork. Both GMs and players see the image. Closing an image window affects only your own view.

The code is stored as a world setting, so players in the world can read it. It grants read-only access to this campaign’s bridge. It cannot reveal entries, edit a campaign, generate artwork, or access a Viscanon account session. Revoke it in Viscanon if the world is shared with someone who should lose access to the campaign’s shared artwork. **Disconnect** stops this world from receiving artwork; it does not revoke the code in other worlds.

## Delivery behavior

A new connection starts at the present moment. Old reveals are not replayed. The delivery position survives reloads and GM failover. Pending events expire after ten minutes. Hidden, unshared, expired, or inaccessible events are skipped. If there is no active GM or the network is interrupted, delivery resumes when the connection returns within that window. Already displayed events are not shown twice during a client session.

This version opens artwork windows. It does not create journals, actors, tokens, scenes, maps, or chat messages. Each world connects to one campaign at a time. Shared images must be managed Viscanon artwork or approved artwork bundled with Viscanon.

## Compatibility and verification

The module targets Foundry VTT 13 and 14 and uses the public `foundry.applications.apps.ImagePopout` and `ApplicationV2` APIs. Installation, the branded connection settings and a revealed image have been confirmed in a licensed Foundry runtime. Its protocol and client behavior also have automated API-mock coverage, strict browser receiver tests and native Chromium coverage. An end-to-end test of Viscanon reveals and shared Memories with a GM and player is still pending. The manifest does not claim a verified Foundry build.

Installing the module alone does not activate the Viscanon service. The campaign connection controls and bridge service must be available in Viscanon.

## Build an install ZIP

Use Node.js 24 or newer and Python 3. No npm dependencies are required.

```sh
node package.mjs /absolute/output/viscanon-bridge.zip
```

The deterministic archive contains exactly six files under `viscanon-bridge/`: the manifest, this README, two runtime scripts, the stylesheet, and the logo. The packager uses an explicit allowlist, so Git metadata, GitHub workflows, build scripts, and release artifacts are excluded. Choose an output path outside the repository.

## Publish a new version

The public repository is [stephenczaja/viscanon-foundry](https://github.com/stephenczaja/viscanon-foundry). Pushing this module-only source to `main` runs the release workflow. It builds the ZIP in the runner’s temporary directory, then creates the versioned release with `viscanon-bridge.zip` and `module.json` attached. It uses the workflow’s `GITHUB_TOKEN`; no external credentials or hosting account are needed. Existing releases and tags are never overwritten.

For later releases, increment `module.json`’s version and update its versioned `download` URL. Keep the `manifest` URL unchanged. Update this README’s version and release description, then push the changes to `main`. The workflow rejects a version that already has a release or tag. Its manual run option provides a retry when a release has not yet been created.

If a run leaves a draft release or tag behind, resolve that separately or use a new version. The workflow will not modify an existing release.

## First Foundry smoke test

1. Enable the module in a test world with one GM and two player browser sessions.
2. Connect a code from a test Viscanon campaign. Existing reveals should not appear.
3. Reveal a location, character, or scene with artwork. Each connected user should see one native image window.
4. Share a GM memory and a player-created memory. Each should show once for every connected Foundry user.
5. Reload the GM, then reveal another entry. The previous entry should stay closed and the new one should arrive.
6. Connect a second GM, disconnect the active GM, and reveal another entry. Delivery should continue through the new active GM.
7. Revoke the code in Viscanon. New artwork should stop arriving. Create and connect a new code to resume.
8. Disconnect in Foundry. New shares should no longer appear in this world.
