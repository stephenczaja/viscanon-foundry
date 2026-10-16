import { DEFAULT_ENDPOINT, MODULE_ID, safeArtworkUrl } from './bridge-core.mjs';

export const PIN_ICON = `modules/${MODULE_ID}/assets/viscanon-eye.svg`;
export const PIN_VISIBILITY = Object.freeze({
  onReveal: 'on_reveal', gmOnly: 'gm_only', visible: 'visible'
});

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_CACHED_ARTWORK = 4;
const IMAGE_TYPES = new Map([
  ['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'],
  ['image/avif', 'avif'], ['image/gif', 'gif']
]);
const PLAYER_LABEL = 'Viscanon artwork';
const FINGERPRINT = /^[a-f0-9]{64}$/;
const PUBLIC_FILE_WARNING = 'Foundry serves uploaded artwork as public files. Anyone with the file URL may fetch them even when a document is GM-only. Confirm public file access before saving this artwork.';
const FOLDER_KEY = /^[a-f0-9]{64}$/;
const ENTRY_CATEGORIES = new Set(['character', 'location', 'scene']);

export function sceneCreateData(entry, imagePath, dimensions, major) {
  const width = Math.round(dimensions.width);
  const height = Math.round(dimensions.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100
    || width > 16384 || height > 16384 || width * height > 100_000_000) {
    throw new Error('Artwork dimensions are not supported by Foundry.');
  }
  const data = {
    name: entry.title,
    width, height,
    grid: { type: 0 },
    backgroundColor: '#000000',
    padding: 0,
    navigation: false
  };
  if (major >= 14) {
    data.levels = [{ name: 'Main', elevation: { bottom: 0, top: 10 }, background: { src: imagePath, color: 0 } }];
  } else {
    data.background = { src: imagePath };
  }
  return data;
}

// Command-time titles can become stale before a GM acts. Only a freshly
// projected public reveal event may replace this neutral player label.
function playerTitle() { return PLAYER_LABEL; }

function ownerLevel() {
  return globalThis.CONST?.DOCUMENT_OWNERSHIP_LEVELS?.OBSERVER ?? 2;
}

function folderFlag(folder, key) {
  return folder.getFlag?.(MODULE_ID, key) ?? folder.flags?.[MODULE_ID]?.[key];
}

function folderParentId(folder) {
  return folder.folder?.id ?? folder.folder ?? null;
}

async function folderKeysFor(command) {
  const { chapterId, chapter, category } = command.entry;
  if (!ENTRY_CATEGORIES.has(category) || (chapter && !chapterId)) return null;
  if (chapterId !== null && chapterId !== undefined
    && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(chapterId)) return null;
  // Folder grouping is optional. Browser crypto failure must never prevent an
  // unrelated hidden pin from losing player access during reconciliation.
  if (!globalThis.crypto?.subtle) return null;
  const group = chapterId || 'unassigned';
  const digest = async value => [...new Uint8Array(await crypto.subtle.digest('SHA-256',
    new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  try {
    return {
      chapter: await digest(`viscanon-folder-v1:chapter:${command.campaignId}:${group}`),
      category: await digest(`viscanon-folder-v1:category:${command.campaignId}:${group}:${category}`)
    };
  } catch {
    return null;
  }
}

/** Foundry-specific document operations, kept separate from the existing artwork receiver. */
export function createWorkspaceActions({
  game: world = globalThis.game,
  foundry: foundryApi = globalThis.foundry,
  fetchImpl = globalThis.fetch.bind(globalThis),
  filePicker = foundryApi.applications.apps.FilePicker,
  imageBitmap = globalThis.createImageBitmap,
  endpoint = DEFAULT_ENDPOINT,
  canvas: board = globalThis.canvas,
  verifyPinVisibility = async () => false,
  checkAction = async () => { throw new Error('Foundry cannot verify this request.'); }
} = {}) {
  // An open popup must not inherit a different GM's authority when accounts
  // switch in the same browser profile while a transfer is in flight.
  const boundUserId = world.user?.id;
  const downloads = new Map();
  const uploads = new Map();
  let pinCursor = 0;

  function assertGM() {
    if (!boundUserId || world.user?.id !== boundUserId || !world.user?.isGM
      || world.users.activeGM?.id !== boundUserId) {
      throw new Error('Only the active GM can use Send to Foundry.');
    }
  }

  function assertFresh(command) {
    if (command.expiresAt <= Date.now()) throw new Error('This Send to Foundry request has expired.');
  }

  async function assertActionCurrent(command) {
    assertGM();
    const current = await checkAction(command);
    assertGM();
    if (current?.id !== command.id || current.campaignId !== command.campaignId
      || current.entry?.id !== command.entry?.id || current.entry.type !== command.entry.type
      || current.entry.artworkFingerprint !== command.entry.artworkFingerprint
      || (current.entry.battlemapFingerprint ?? null) !== (command.entry.battlemapFingerprint ?? null)) {
      throw new Error('This Send to Foundry request changed. Send the entry again.');
    }
    return current;
  }

  async function imageDimensions(blob) {
    if (typeof imageBitmap !== 'function') throw new Error('This Foundry browser cannot measure the artwork.');
    const bitmap = await imageBitmap(blob);
    try { return { width: bitmap.width, height: bitmap.height }; }
    finally { bitmap.close?.(); }
  }

  function artworkSource(command, purpose) {
    return purpose === 'battlemap' && command.entry.battlemap
      && command.entry.battlemap !== command.entry.image ? 'battlemap' : 'image';
  }

  async function prefetchArtwork(command, purpose = 'image') {
    assertGM();
    const source = artworkSource(command, purpose);
    const key = `${command.id}:${source}`;
    if (downloads.has(key)) return downloads.get(key);
    const job = (async () => {
      const url = source === 'battlemap' ? command.entry.battlemap : command.entry.image;
      if (!safeArtworkUrl(url, endpoint)) throw new Error('Viscanon returned an unsupported artwork URL.');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      let response;
      try {
        response = await fetchImpl(url, { method: 'GET', mode: 'cors', credentials: 'omit',
          cache: 'no-store', signal: controller.signal });
        if (!response.ok) throw new Error(`Artwork download failed (${response.status}).`);
        const length = Number(response.headers?.get?.('content-length'));
        if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) throw new Error('Artwork is too large for this transfer.');
        const blob = await response.blob();
        if (blob.size <= 0 || blob.size > MAX_IMAGE_BYTES) throw new Error('Artwork is empty or too large for this transfer.');
        const mime = String(blob.type || response.headers?.get?.('content-type') || '').split(';')[0].toLowerCase();
        const extension = IMAGE_TYPES.get(mime);
        if (!extension) throw new Error('Artwork uses an unsupported image format.');
        const dimensions = await imageDimensions(blob);
        assertGM();
        if (!Number.isFinite(dimensions.width) || !Number.isFinite(dimensions.height)
          || dimensions.width < 1 || dimensions.height < 1
          || dimensions.width > 16384 || dimensions.height > 16384
          || dimensions.width * dimensions.height > 100_000_000) {
          throw new Error('Artwork dimensions are not supported by Foundry.');
        }
        return { blob, mime, extension, dimensions };
      } finally {
        clearTimeout(timeout);
      }
    })();
    while (downloads.size >= MAX_CACHED_ARTWORK) downloads.delete(downloads.keys().next().value);
    downloads.set(key, job);
    try { return await job; }
    catch (error) { downloads.delete(key); throw error; }
  }

  async function saveArtwork(command, purpose = 'image',
    { disclosedToPlayers = false, beforeUpload = null, checkCurrentAction = true } = {}) {
    assertGM();
    if (!disclosedToPlayers) throw new Error(PUBLIC_FILE_WARNING);
    const key = `${command.id}:${artworkSource(command, purpose)}`;
    if (uploads.has(key)) {
      const saved = await uploads.get(key);
      // A cached path does not grant authority to act again. The receipt may
      // have been revoked or the receiver session may have changed meanwhile.
      if (checkCurrentAction) await assertActionCurrent(command);
      if (beforeUpload && await beforeUpload() !== true) {
        throw new Error('The artwork is no longer revealed in Viscanon.');
      }
      assertGM();
      return saved;
    }
    const job = (async () => {
      const { blob, mime, extension, dimensions } = await prefetchArtwork(command, purpose);
      assertGM();
      if (checkCurrentAction) await assertActionCurrent(command);
      if (beforeUpload && await beforeUpload() !== true) {
        throw new Error('The artwork is no longer revealed in Viscanon.');
      }
      assertGM();
      if (typeof filePicker?.uploadPersistent !== 'function') {
        throw new Error('Foundry persistent module storage is unavailable.');
      }
      // Only a chosen action persists the bytes. The path is independent from
      // any command, title, or entry identifier.
      const randomName = [...crypto.getRandomValues(new Uint8Array(16))]
        .map(byte => byte.toString(16).padStart(2, '0')).join('');
      const file = new File([blob], `${randomName}.${extension}`, { type: mime });
      assertGM();
      const uploaded = await filePicker.uploadPersistent(MODULE_ID, '', file, {}, { notify: false });
      assertGM();
      if (typeof uploaded?.path !== 'string' || !uploaded.path || uploaded.path.includes('..')
        || /^[a-z]+:\/\//i.test(uploaded.path)) throw new Error('Foundry did not return a usable artwork path.');
      return { path: uploaded.path, dimensions };
    })();
    uploads.set(key, job);
    try { return await job; }
    catch (error) { uploads.delete(key); throw error; }
  }

  function releaseArtwork(command) {
    for (const source of ['image', 'battlemap']) {
      const key = `${command.id}:${source}`;
      downloads.delete(key);
      uploads.delete(key);
    }
  }

  async function ensureFolder(type, keys = null) {
    assertGM();
    const folders = () => world.folders?.contents ?? [...world.folders];
    const existing = folders().find(folder => folder.type === type && folderParentId(folder) === null
      && folderFlag(folder, 'workspaceFolder') === 'root' && folder.name === 'Viscanon');
    const root = existing ?? await globalThis.CONFIG.Folder.documentClass.create({ name: 'Viscanon', type, folder: null,
      flags: { [MODULE_ID]: { workspaceFolder: 'root' } } });
    if (!keys || !FOLDER_KEY.test(keys.chapter ?? '') || !FOLDER_KEY.test(keys.category ?? '')) return root;
    // Foundry folder metadata may reach player clients. Never place a private
    // label, source UUID or chapter/category text in a Folder name or flag.
    const ensureChild = async (parent, role, key, prefix) => {
      assertGM();
      const name = `${prefix} ${key.slice(0, 12)}`;
      return folders().find(folder => folder.type === type && folderParentId(folder) === parent.id
        && folderFlag(folder, 'workspaceFolder') === role && folderFlag(folder, 'folderKey') === key
        && folder.name === name) ?? globalThis.CONFIG.Folder.documentClass.create({
        name, type, folder: parent.id,
        flags: { [MODULE_ID]: { workspaceFolder: role, folderKey: key } }
      });
    };
    const chapterFolder = await ensureChild(root, 'chapter', keys.chapter, 'Section');
    return ensureChild(chapterFolder, 'category', keys.category, 'Group');
  }

  async function organizePin(journal, exposed, keys = null) {
    // A private pin stays at the neutral root: even a neutral child folder
    // could reveal the number of unrevealed chapters or categories.
    if (!world.folders || !globalThis.CONFIG?.Folder?.documentClass?.create) return;
    // A local Foundry Reveal remains exposed without a Viscanon shared state.
    // Its existing folder is retained when no fresh server grouping is sent.
    if (exposed && !keys) return;
    const folder = await ensureFolder('JournalEntry', exposed ? keys : null);
    assertGM();
    if ((journal.folder?.id ?? journal.folder) !== folder.id) await journal.update({ folder: folder.id });
  }

  function getPins(campaignId) {
    if (!campaignId) return [];
    const all = [];
    const seen = new Map();
    for (const journal of world.journal?.contents ?? []) {
      const flags = journal.flags?.[MODULE_ID];
      if (flags?.campaignId !== campaignId || flags.visibility !== PIN_VISIBILITY.onReveal
        || !flags.entryId || !FINGERPRINT.test(flags.artworkFingerprint ?? '')) continue;
      const key = `${flags.entryId}:${flags.artworkFingerprint}`;
      if (seen.has(key)) {
        seen.get(key).needsArtwork ||= !publishedPinArtwork(journal);
      } else {
        const pin = { entryId: flags.entryId, fingerprint: flags.artworkFingerprint,
          needsArtwork: !publishedPinArtwork(journal) };
        seen.set(key, pin);
        all.push(pin);
      }
    }
    if (!all.length) return [];
    const start = pinCursor % all.length;
    pinCursor = (start + 20) % all.length;
    return [...all.slice(start), ...all.slice(0, start)].slice(0, 20);
  }

  async function setPinVisibility(journal, exposed, publicTitle = PLAYER_LABEL) {
    assertGM();
    const level = exposed ? ownerLevel() : 0;
    const safeTitle = String(publicTitle || PLAYER_LABEL).trim().slice(0, 240) || PLAYER_LABEL;
    const pages = journal.pages?.contents ?? [];
    const gmIds = new Set((world.users?.contents ?? Array.from(world.users ?? []))
      .filter(user => user.isGM).map(user => user.id));
    if (world.users?.activeGM?.id) gmIds.add(world.users.activeGM.id);
    const ownershipChange = document => {
      const current = document.ownership ?? {};
      const next = {default: level};
      let changed = Number(current.default ?? 0) !== level;
      // Foundry merges ownership updates. A default-only change leaves an
      // explicit player grant (or deny) in force, including after an Undo.
      for (const [userId, permission] of Object.entries(current)) {
        if (userId === 'default' || gmIds.has(userId)) continue;
        if (Number(permission) !== level) {
          next[userId] = level;
          changed = true;
        }
      }
      return changed ? {ownership: next} : null;
    };
    if (exposed) {
      // Replace the private GM title before any player permission is granted.
      if (journal.name !== safeTitle) { assertGM(); await journal.update({ name: safeTitle }); }
      for (const page of pages) {
        if (page.name !== safeTitle) { assertGM(); await page.update({ name: safeTitle }); }
      }
      for (const page of pages) {
        const change = ownershipChange(page);
        if (change) { assertGM(); await page.update(change); }
      }
      const change = ownershipChange(journal);
      if (change) { assertGM(); await journal.update(change); }
    } else {
      // Hide the parent first so page metadata cannot remain player-readable.
      const change = ownershipChange(journal);
      if (change) { assertGM(); await journal.update(change); }
      for (const page of pages) {
        const change = ownershipChange(page);
        if (change) { assertGM(); await page.update(change); }
      }
    }
  }

  function publishedPinArtwork(journal) {
    const path = journal.flags?.[MODULE_ID]?.publicArtworkPath;
    return typeof path === 'string' && path.length > 0
      && journal.pages?.contents?.[0]?.src === path;
  }

  function pinNeedsGrant(journal) {
    const level = ownerLevel();
    const gmIds = new Set((world.users?.contents ?? Array.from(world.users ?? []))
      .filter(user => user.isGM).map(user => user.id));
    if (world.users?.activeGM?.id) gmIds.add(world.users.activeGM.id);
    const needsGrant = document => {
      const ownership = document.ownership ?? {};
      if (Number(ownership.default ?? 0) !== level) return true;
      return Object.entries(ownership).some(([userId, value]) =>
        userId !== 'default' && !gmIds.has(userId) && Number(value) !== level);
    };
    return needsGrant(journal) || (journal.pages?.contents ?? []).some(needsGrant);
  }

  async function setPublishedPinArtwork(journal, path) {
    assertGM();
    if (typeof path !== 'string' || !path || path.includes('..') || /^[a-z]+:\/\//i.test(path)) {
      throw new Error('Foundry did not return a usable artwork path.');
    }
    const page = journal.pages?.contents?.[0];
    if (!page) throw new Error('The map pin artwork page is missing.');
    if (publishedPinArtwork(journal) && page.src === path) return;
    assertGM();
    await page.update({ src: path });
    assertGM();
    await journal.update({ [`flags.${MODULE_ID}.publicArtworkPath`]: path });
  }

  async function hydrateRevealedPin(journal, image) {
    assertGM();
    if (!safeArtworkUrl(image, endpoint)) throw new Error('The revealed artwork URL is unavailable.');
    const flags = journal.flags?.[MODULE_ID];
    const request = { id: `revealed-pin:${journal.id}:${flags?.artworkFingerprint}`,
      entry: { image, battlemap: '' } };
    const proof = { campaignId: flags.campaignId, entryId: flags.entryId,
      fingerprint: flags.artworkFingerprint };
    const saved = await saveArtwork(request, 'image', { disclosedToPlayers: true,
      // The poll's reveal snapshot may have been undone during the download.
      beforeUpload: () => verifyPinVisibility(proof), checkCurrentAction: false });
    await setPublishedPinArtwork(journal, saved.path);
    releaseArtwork(request);
  }

  async function promotePins({ campaignId, itemId, fingerprint, local = false, artworkPath = '', folderKeys = null,
    beforeGrant = null }) {
    assertGM();
    if (!FINGERPRINT.test(fingerprint ?? '')) return;
    for (const journal of world.journal?.contents ?? []) {
      const flags = journal.flags?.[MODULE_ID];
      if (flags?.campaignId !== campaignId || flags?.entryId !== itemId
        || flags.visibility !== PIN_VISIBILITY.onReveal
        || flags.artworkFingerprint !== fingerprint) continue;
      // Keep the Journal hidden while its public image page is prepared. The
      // direct Reveal choice is the GM's explicit publication decision.
      await setPinVisibility(journal, false);
      if (local) {
        if (beforeGrant) await beforeGrant();
        await setPublishedPinArtwork(journal, artworkPath);
      }
      if (!publishedPinArtwork(journal)) throw new Error('Pin artwork was not published; the pin remains GM-only.');
      if (beforeGrant) await beforeGrant();
      await setPinVisibility(journal, true, PLAYER_LABEL);
      // This flag allows a later poll to preserve the GM's explicit local
      // share. Never store it before the final receipt check and grant.
      if (local && !flags.localRevealed) {
        assertGM();
        try { await journal.update({ [`flags.${MODULE_ID}.localRevealed`]: true }); }
        catch (error) {
          await setPinVisibility(journal, false);
          throw error;
        }
      }
      await organizePin(journal, true, folderKeys);
    }
  }

  async function reconcilePins({ campaignId, requested, visiblePins, visiblePinArtwork = [], visiblePinFolders = [] }) {
    assertGM();
    const queried = new Set(requested.map(pin => `${pin.entryId}:${pin.fingerprint}`));
    const approved = new Set(visiblePins.map(pin => `${pin.entryId}:${pin.fingerprint}`)
      .filter(key => queried.has(key)));
    const signedArtwork = new Map();
    for (const item of visiblePinArtwork) {
      const key = `${item.entryId}:${item.fingerprint}`;
      if (approved.has(key) && safeArtworkUrl(item.image, endpoint)) signedArtwork.set(key, item.image);
    }
    const approvedFolders = new Map();
    for (const item of visiblePinFolders) {
      const key = `${item.entryId}:${item.fingerprint}`;
      if (approved.has(key)) approvedFolders.set(key, await folderKeysFor({ campaignId,
        entry: { chapterId: item.chapterId, chapter: '', category: item.category } }));
    }
    const failures = [];
    for (const journal of world.journal?.contents ?? []) {
      assertGM();
      const flags = journal.flags?.[MODULE_ID];
      if (flags?.campaignId !== campaignId || flags.visibility !== PIN_VISIBILITY.onReveal) continue;
      const key = `${flags.entryId}:${flags.artworkFingerprint}`;
      if (!queried.has(key)) continue;
      const exposed = flags.localRevealed === true || approved.has(key);
      try {
        if (!exposed) {
          await setPinVisibility(journal, false);
          await organizePin(journal, false);
          continue;
        }
        if (!publishedPinArtwork(journal)) {
          await setPinVisibility(journal, false);
          const image = signedArtwork.get(key);
          if (!image) throw new Error('Freshly approved artwork is unavailable.');
          await hydrateRevealedPin(journal, image);
        }
        if (approved.has(key) && pinNeedsGrant(journal)) {
          const stillVisible = await verifyPinVisibility({ campaignId,
            entryId: flags.entryId, fingerprint: flags.artworkFingerprint });
          assertGM();
          if (stillVisible !== true) throw new Error('The artwork reveal changed before the pin could be opened.');
        }
        await setPinVisibility(journal, true, PLAYER_LABEL);
        await organizePin(journal, true, approvedFolders.get(key));
      } catch (error) {
        // An image transfer failure must never expose a placeholder or an
        // unverified private image page. Continue revoking other pins even if
        // this Journal or its folder fails to update.
        assertGM();
        failures.push(error);
        if (exposed) {
          try { await setPinVisibility(journal, false); }
          catch (hideError) { assertGM(); failures.push(hideError); }
          try { await organizePin(journal, false); }
          catch (folderError) { assertGM(); failures.push(folderError); }
        }
      }
    }
    const remoteError = failures.find(error => typeof error?.status === 'number'
      || error?.name === 'AbortError');
    if (remoteError) throw remoteError;
    if (failures.length) throw new Error(`${failures.length} pin update(s) failed; check affected pin permissions and artwork: ${failures[0]?.message || 'Foundry update failed.'}`, { cause: failures[0] });
  }

  async function revealArtwork(command) {
    assertGM();
    const folderKeys = await folderKeysFor(command);
    const saved = await saveArtwork(command, 'image', { disclosedToPlayers: true,
      checkCurrentAction: true });
    const ImagePopout = foundryApi.applications.apps.ImagePopout;
    const title = playerTitle();
    const popout = new ImagePopout({ src: saved.path, showTitle: true,
      classes: [...(ImagePopout.DEFAULT_OPTIONS?.classes ?? []), 'viscanon-bridge-artwork'],
      window: { title } });
    await popout.render({ force: true });
    await assertActionCurrent(command);
    await popout.shareImage({ image: saved.path, title, showTitle: true });
    await assertActionCurrent(command);
    await promotePins({ campaignId: command.campaignId, itemId: command.entry.id,
      fingerprint: command.entry.artworkFingerprint, local: true, artworkPath: saved.path,
      folderKeys, beforeGrant: () => assertActionCurrent(command) });
    return saved;
  }

  async function createScene(command, allowPublicArtwork = false) {
    assertGM();
    if (!allowPublicArtwork) throw new Error(PUBLIC_FILE_WARNING);
    const major = Number(world.release?.generation ?? String(world.version).split('.')[0]);
    if (!Number.isFinite(major) || major < 13 || major > 14) throw new Error('This Foundry version is not supported.');
    const saved = await saveArtwork(command, 'battlemap', { disclosedToPlayers: true,
      checkCurrentAction: true });
    await assertActionCurrent(command);
    const folder = await ensureFolder('Scene');
    const data = sceneCreateData({ ...command.entry, title: playerTitle() }, saved.path, saved.dimensions, major);
    data.folder = folder.id;
    data.ownership = { default: 0 };
    await assertActionCurrent(command);
    const scene = await globalThis.CONFIG.Scene.documentClass.create(data);
    if (!scene) throw new Error('Foundry did not create the scene.');
    return scene;
  }

  async function captureMapPoint(scene) {
    assertGM();
    if (board?.scene?.id !== scene.id) await scene.view();
    assertGM();
    const view = board?.app?.view ?? board?.app?.renderer?.view;
    if (!view?.addEventListener || !board.stage?.toLocal) throw new Error('Foundry map placement is unavailable.');
    globalThis.ui.notifications.info('Click the map to place the Viscanon eye, or press Escape to cancel.');
    return new Promise((resolve, reject) => {
      const finish = () => {
        view.removeEventListener('pointerdown', click, true);
        document.removeEventListener('keydown', escape, true);
      };
      const escape = event => {
        if (event.key !== 'Escape') return;
        finish();
        reject(new Error('Map pin placement cancelled.'));
      };
      const click = event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        finish();
        try { assertGM(); }
        catch (error) { reject(error); return; }
        const rect = view.getBoundingClientRect();
        const renderer = board.app.renderer;
        const point = board.stage.toLocal({
          x: (event.clientX - rect.left) * renderer.width / rect.width,
          y: (event.clientY - rect.top) * renderer.height / rect.height
        });
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
          || point.x < 0 || point.y < 0 || point.x > scene.width || point.y > scene.height) {
          reject(new Error('Choose a point inside the scene.'));
        } else resolve({ x: Math.round(point.x), y: Math.round(point.y) });
      };
      view.addEventListener('pointerdown', click, true);
      document.addEventListener('keydown', escape, true);
    });
  }

  async function placePin(command, sceneId, visibility) {
    assertGM();
    if (!Object.values(PIN_VISIBILITY).includes(visibility)) throw new Error('Choose a pin visibility.');
    const scene = world.scenes?.get(sceneId);
    if (!scene) throw new Error('Choose an existing Foundry scene.');
    const position = await captureMapPoint(scene);
    await assertActionCurrent(command);
    // The popup's revealed snapshot may already be stale after an Undo. Only
    // the fresh fingerprint reconciliation may promote an on-reveal pin.
    const exposed = visibility === PIN_VISIBILITY.visible;
    const folderKeys = exposed ? await folderKeysFor(command) : null;
    // Foundry serves persistent files to players regardless of Journal
    // ownership. An unrevealed pin contains only this public module icon.
    const saved = exposed ? await saveArtwork(command, 'image', {
      disclosedToPlayers: true, checkCurrentAction: true }) : null;
    // Hidden Foundry document metadata may replicate to players in some
    // versions, so no private Viscanon title is stored here at all.
    const name = playerTitle();
    await assertActionCurrent(command);
    const folder = await ensureFolder('JournalEntry', exposed ? folderKeys : null);
    const ownership = { default: exposed ? ownerLevel() : 0 };
    const pinFlags = visibility === PIN_VISIBILITY.onReveal
      ? { visibility, campaignId: command.campaignId, entryId: command.entry.id,
        artworkFingerprint: command.entry.artworkFingerprint, localRevealed: false,
        publicArtworkPath: '' }
      : { visibility, publicArtworkPath: saved?.path ?? '' };
    await assertActionCurrent(command);
    const journal = await globalThis.CONFIG.JournalEntry.documentClass.create({
      name, folder: folder.id, ownership,
      pages: [{ name, type: 'image', src: saved?.path ?? PIN_ICON, ownership }],
      flags: { [MODULE_ID]: pinFlags }
    });
    if (!journal) throw new Error('Foundry did not create the pin journal.');
    try {
      const pageId = journal.pages?.contents?.[0]?.id;
      if (!pageId) throw new Error('Foundry did not create the pin artwork page.');
      await assertActionCurrent(command);
      const notes = await scene.createEmbeddedDocuments('Note', [{
        entryId: journal.id, pageId, ...position, global: true, iconSize: 48,
        texture: { src: PIN_ICON }
      }]);
      if (!notes?.length) throw new Error('Foundry did not create the map pin.');
      return { journal, note: notes[0], folderStatus: exposed
        ? folderKeys ? 'nested' : 'unavailable' : 'private' };
    } catch (error) {
      // The only document this operation created is safe to remove if pin creation failed.
      if (world.user?.id === boundUserId && world.user?.isGM) await journal.delete();
      throw error;
    }
  }

  function actorTypes() {
    const types = world.documentTypes?.Actor ?? world.system?.documentTypes?.Actor
      ?? globalThis.CONFIG?.Actor?.documentClass?.TYPES ?? [];
    return Array.isArray(types) ? types.filter(type => typeof type === 'string') : [];
  }

  function actorVisibleToPlayers(actor) {
    const users = world.users?.contents ?? [...(world.users ?? [])];
    if (!users.length) return true; // Unknown visibility must be treated as player-visible.
    return users.some(user => !user.isGM && (actor.testUserPermission?.(user, 'LIMITED')
      ?? Number(actor.ownership?.[user.id] ?? actor.ownership?.default ?? 0) >= 1));
  }

  async function attachActor(command, actorId, newType = '', allowPlayerVisibility = false,
    allowPublicArtwork = false) {
    assertGM();
    if (actorId) {
      const actor = world.actors?.get(actorId);
      if (!actor) throw new Error('Choose an existing actor.');
      if (actorVisibleToPlayers(actor) && !allowPlayerVisibility) {
        throw new Error('This actor is visible to players. Choose “Visible to players now” to attach artwork.');
      }
      if (!allowPublicArtwork) throw new Error(PUBLIC_FILE_WARNING);
      const saved = await saveArtwork(command, 'image', { disclosedToPlayers: true,
        checkCurrentAction: true });
      await assertActionCurrent(command);
      await actor.update({ img: saved.path });
      return actor;
    }
    if (!actorTypes().includes(newType)) throw new Error('Choose an actor type supported by this game system.');
    if (!allowPublicArtwork) throw new Error(PUBLIC_FILE_WARNING);
    const saved = await saveArtwork(command, 'image', { disclosedToPlayers: true,
      checkCurrentAction: true });
    await assertActionCurrent(command);
    const folder = await ensureFolder('Actor');
    await assertActionCurrent(command);
    const actor = await globalThis.CONFIG.Actor.documentClass.create({
      name: playerTitle(), type: newType, img: saved.path, folder: folder.id,
      ownership: { default: 0 }
    });
    if (!actor) throw new Error('Foundry did not create the actor.');
    return actor;
  }

  return { assertFresh, prefetchArtwork, saveArtwork, releaseArtwork,
    revealArtwork, createScene, placePin,
    getPins, reconcilePins, promotePins, actorTypes, attachActor };
}
