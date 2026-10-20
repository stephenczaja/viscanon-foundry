import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { DEFAULT_ENDPOINT, MODULE_ID } from '../scripts/bridge-core.mjs';
import { createWorkspaceActions, PIN_ICON } from '../scripts/workspace-actions.mjs';
import { validateWorkspaceCommand, WorkspaceController } from '../scripts/workspace-core.mjs';

const CAMPAIGN = '10000000-0000-4000-8000-000000000001';
const ENTRY = '20000000-0000-4000-8000-000000000001';
const COMMAND = '30000000-0000-4000-8000-000000000001';
const IMAGE = `${new URL(DEFAULT_ENDPOINT).origin}/storage/v1/object/sign/artwork/generated-token.png?token=synthetic`;
const SAVED = 'persistent/synthetic-generated-token.png';

// Valid transparent PNG bytes, produced locally without any artwork service.
function png(width = 1024, height = 1024) {
  const chunk = (name, data) => {
    const type = Buffer.from(name), payload = Buffer.concat([type, data]);
    let crc = 0xffffffff;
    for (const byte of payload) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4), checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, payload, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function command() {
  return { id: COMMAND, action: 'open', campaignId: CAMPAIGN, intent: 'token', expiresAt: Date.now() + 60_000,
    entry: { id: ENTRY, type: 'character', category: 'character', title: 'Preview label', entryName: 'Canonical Ambrose',
      chapterId: null, image: IMAGE, artworkFingerprint: digest(PNG), battlemap: '', battlemapFingerprint: null, revealed: false } };
}
function rawCommand() {
  const value = command();
  value.expiresAt = new Date(value.expiresAt).toISOString();
  return value;
}
function setDotted(target, key, value) {
  const parts = key.split('.'), leaf = parts.pop();
  for (const part of parts) target = target[part] ??= {};
  target[leaf] = value;
}
const actorData = actor => structuredClone(Object.fromEntries(Object.entries(actor).filter(([, value]) => typeof value !== 'function')));

async function withFixture(run) {
  const previousConfig = globalThis.CONFIG;
  const fx = { command: command(), bytes: PNG, mime: 'image/png', revealed: false,
    fetches: [], uploads: [], updates: [], creates: [], folders: [], checks: [], placedWrites: [], events: [], bitmapsClosed: 0 };
  const placed = ['placed-one', 'placed-two'].map(id => ({ id, actorId: 'actor-existing', texture: { src: `${id}.png`, scaleX: 0.7 },
    x: 123, y: 456, name: id, flags: { custom: true },
    async update(changes) { fx.placedWrites.push(changes); throw Error('Placed tokens must remain untouched.'); } }));
  fx.actor = { id: 'actor-existing', name: 'Keep this actor name', img: 'portraits/keep.webp', ownership: { default: 0 },
    system: { untouched: true }, flags: { custom: { keep: true } },
    prototypeToken: { name: 'Custom token name', disposition: 1, displayName: 30, randomImg: true,
      texture: { src: 'tokens/old.png', scaleX: 1.3, scaleY: 0.8, offsetX: 0.15 }, flags: { custom: { keep: true } } },
    async update(changes) {
      fx.events.push('actor:update'); fx.updates.push(structuredClone(changes));
      for (const [key, value] of Object.entries(changes)) setDotted(this, key, value);
      if (fx.onUpdate) return fx.onUpdate(this, changes);
      return this;
    } };
  fx.world = { user: { id: 'gm', isGM: true },
    users: { activeGM: { id: 'gm' }, contents: [{ id: 'gm', isGM: true }, { id: 'player', isGM: false }] },
    documentTypes: { Actor: ['npc', 'character'] },
    actors: { contents: [fx.actor], get(id) { return this.contents.find(actor => actor.id === id); } },
    folders: { contents: [{ id: 'actor-folder', type: 'Actor', name: 'Viscanon', folder: null,
      flags: { [MODULE_ID]: { workspaceFolder: 'root' } } }] },
    scenes: { contents: placed.map(token => ({ tokens: { contents: [token] } })) }, journal: { contents: [] } };
  fx.placed = placed;
  globalThis.CONFIG = {
    Actor: { documentClass: { async create(data) {
      fx.events.push('actor:create'); fx.creates.push(structuredClone(data));
      if (fx.onCreate) return fx.onCreate(data);
      const actor = { id: 'created-actor', img: 'system/default-portrait.svg', ...structuredClone(data) };
      fx.world.actors.contents.push(actor); return actor;
    } } },
    Folder: { documentClass: { async create(data) {
      fx.folders.push(structuredClone(data)); const folder = { id: 'created-folder', ...data };
      fx.world.folders.contents.push(folder); return folder;
    } } }
  };
  fx.actions = createWorkspaceActions({ game: fx.world, foundry: { applications: { apps: {} } }, canvas: null,
    checkAction: async value => {
      fx.events.push('check'); fx.checks.push(value);
      const current = { ...value, entry: { ...value.entry, revealed: fx.revealed } };
      if (fx.onCheck) await fx.onCheck(current);
      return current;
    },
    fetchImpl: async (url, options) => {
      fx.events.push('download'); fx.fetches.push({ url, options });
      if (fx.onFetch) await fx.onFetch();
      return { ok: true, headers: { get: name => name === 'content-length' ? String(fx.bytes.length) : fx.mime },
        blob: async () => new Blob([fx.bytes], { type: fx.mime }) };
    },
    imageBitmap: async blob => {
      if (fx.onMeasure) await fx.onMeasure();
      const bytes = Buffer.from(await blob.arrayBuffer());
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), close() { fx.bitmapsClosed++; } };
    },
    filePicker: { async uploadPersistent(module, folder, file, options, notify) {
      fx.events.push('upload'); fx.uploads.push({ module, folder, file, options, notify });
      if (fx.onUpload) await fx.onUpload();
      return { path: SAVED };
    } }
  });
  fx.attach = (actorId = fx.actor.id, type = '') => fx.actions.attachToken(fx.command, actorId, type, false, true);
  try { return await run(fx); }
  finally {
    fx.actions.destroy();
    if (previousConfig === undefined) delete globalThis.CONFIG;
    else globalThis.CONFIG = previousConfig;
  }
}

test('existing actor receives one exact prototype texture leaf patch and preserves portrait, name, siblings and placed tokens', async () => {
  await withFixture(async fx => {
    const before = actorData(fx.actor), placed = fx.placed.map(actorData);
    const attached = await fx.attach();
    assert.equal(attached, fx.actor);
    assert.deepEqual(fx.updates, [{ 'prototypeToken.texture.src': SAVED }]);
    before.prototypeToken.texture.src = SAVED;
    assert.deepEqual(actorData(fx.actor), before);
    assert.deepEqual(fx.placed.map(actorData), placed); assert.deepEqual(fx.placedWrites, []);
    assert.deepEqual(fx.creates, []); assert.deepEqual(fx.folders, []);
    assert.equal(fx.uploads.length, 1);
    const upload = fx.uploads[0];
    assert.equal(upload.module, MODULE_ID); assert.equal(upload.folder, '');
    assert.match(upload.file.name, /^[a-f0-9]{32}\.png$/);
    assert.equal(upload.file.type, 'image/png');
    assert.equal(digest(Buffer.from(await upload.file.arrayBuffer())), fx.command.entry.artworkFingerprint);
    assert.equal(fx.bitmapsClosed, 1);
  });
});

test('new token actor uses the canonical entry name, private ownership and default portrait', async () => {
  await withFixture(async fx => {
    const actor = await fx.attach('', 'npc');
    assert.deepEqual(fx.creates, [{ name: 'Canonical Ambrose', type: 'npc', folder: 'actor-folder', ownership: { default: 0 },
      prototypeToken: { texture: { src: SAVED } } }]);
    assert.equal(Object.hasOwn(fx.creates[0], 'img'), false);
    assert.equal(actor.img, 'system/default-portrait.svg');
    assert.equal(actor.prototypeToken.texture.src, SAVED);
    assert.deepEqual(fx.updates, []); assert.deepEqual(fx.placedWrites, []);
  });
});

test('player-visible actor requires fresh source reveal before downloading or attaching a token', async () => {
  await withFixture(async fx => {
    fx.actor.ownership.default = 1;
    await assert.rejects(fx.attach(), /Reveal the source artwork/);
    assert.equal(fx.fetches.length + fx.uploads.length + fx.updates.length, 0);
    fx.revealed = true;
    await fx.attach();
    assert.equal(fx.updates.length, 1);
  });
});

test('source reveal revoked during upload prevents a player-visible actor mutation', async () => {
  await withFixture(async fx => {
    fx.actor.ownership.default = 2; fx.revealed = true;
    fx.onUpload = () => { fx.revealed = false; };
    await assert.rejects(fx.attach(), /Reveal the source artwork/);
    assert.equal(fx.uploads.length, 1); assert.deepEqual(fx.updates, []);
  });
});

async function postUploadChecksToCommit() {
  return withFixture(async fx => {
    let count = 0;
    fx.onCheck = () => { if (fx.uploads.length) count++; };
    await fx.attach();
    assert.ok(count > 0, 'an uploaded token is revalidated before document mutation');
    return count;
  });
}

test('the final command revalidation cannot bypass a revoked source reveal', async () => {
  const lastCheck = await postUploadChecksToCommit();
  await withFixture(async fx => {
    fx.actor.ownership.default = 2; fx.revealed = true;
    let checksAfterUpload = 0;
    fx.onCheck = current => {
      if (fx.uploads.length && ++checksAfterUpload === lastCheck) current.entry.revealed = false;
    };
    await assert.rejects(fx.attach(), /Reveal the source artwork/);
    assert.deepEqual(fx.updates, []);
  });
});

test('the final command revalidation cannot update an actor removed from the world', async () => {
  const lastCheck = await postUploadChecksToCommit();
  await withFixture(async fx => {
    let checksAfterUpload = 0;
    fx.onCheck = () => {
      if (fx.uploads.length && ++checksAfterUpload === lastCheck) fx.world.actors.contents = [];
    };
    await assert.rejects(fx.attach(), /actor changed|Choose an existing actor/);
    assert.deepEqual(fx.updates, []);
  });
});

for (const [stage, revoke] of [
  ['before download', fx => { fx.world.user.isGM = false; }],
  ['during download', fx => { fx.onFetch = () => { fx.world.users.activeGM = { id: 'other-gm' }; }; }],
  ['during image measurement', fx => { fx.onMeasure = () => { fx.world.user = { id: 'other-gm', isGM: true }; }; }],
  ['during upload', fx => { fx.onUpload = () => { fx.world.users.activeGM = { id: 'other-gm' }; }; }],
  ['after upload', fx => { fx.onCheck = () => { if (fx.uploads.length) fx.world.user.isGM = false; }; }]
]) test(`active GM authority lost ${stage} prevents actor mutation`, async () => {
  await withFixture(async fx => {
    revoke(fx);
    await assert.rejects(fx.attach(), /Only the active GM/);
    assert.deepEqual(fx.updates, []); assert.deepEqual(fx.creates, []);
    if (['before download', 'during download', 'during image measurement'].includes(stage)) assert.deepEqual(fx.uploads, []);
  });
});

test('token digest mismatch uploads nothing, evicts failed bytes and permits a verified retry', async () => {
  await withFixture(async fx => {
    fx.bytes = Buffer.from(PNG); fx.bytes[fx.bytes.length - 1] ^= 1;
    await assert.rejects(fx.attach(), /generated token changed/);
    assert.deepEqual(fx.uploads, []); assert.deepEqual(fx.updates, []);
    fx.bytes = PNG;
    await fx.attach();
    assert.equal(fx.fetches.length, 2); assert.equal(fx.updates.length, 1);
  });
});

for (const [width, height] of [[1023, 1024], [1024, 1023], [512, 512], [2048, 1024]]) {
  test(`generated token must be exactly 1024 square, rejecting ${width} × ${height}`, async () => {
    await withFixture(async fx => {
      fx.bytes = png(width, height); fx.command.entry.artworkFingerprint = digest(fx.bytes);
      await assert.rejects(fx.attach(), /1024 × 1024/);
      assert.deepEqual(fx.uploads, []); assert.deepEqual(fx.updates, []);
      assert.equal(fx.bitmapsClosed, 1);
    });
  });
}

test('non-PNG and over-six-megabyte token images never upload', async () => {
  for (const kind of ['webp', 'oversized']) await withFixture(async fx => {
    if (kind === 'webp') fx.mime = 'image/webp';
    else fx.bytes = Buffer.alloc(6 * 1024 * 1024 + 1);
    fx.command.entry.artworkFingerprint = digest(fx.bytes);
    await assert.rejects(fx.attach(), /Invalid generated token image/);
    assert.deepEqual(fx.uploads, []); assert.deepEqual(fx.updates, []);
  });
});

test('token attachment requires explicit token intent and public file acknowledgement', async () => {
  await withFixture(async fx => {
    const artwork = { ...fx.command }; delete artwork.intent;
    await assert.rejects(fx.actions.attachToken(artwork, fx.actor.id, '', false, true), /Send a generated token/);
    await assert.rejects(fx.actions.attachToken(fx.command, fx.actor.id), /public files/);
    assert.equal(fx.fetches.length + fx.checks.length + fx.updates.length, 0);
  });
});

test('changed intent or token revision during action revalidation cannot upload or mutate an actor', async () => {
  for (const kind of ['intent', 'bytes']) await withFixture(async fx => {
    fx.onCheck = current => {
      if (kind === 'intent') delete current.intent;
      else current.entry.artworkFingerprint = 'b'.repeat(64);
    };
    await assert.rejects(fx.attach(), /request changed/);
    assert.equal(fx.fetches.length + fx.uploads.length + fx.updates.length, 0);
  });
});

test('token intent cannot invoke artwork reveal, scene creation, map placement or portrait attachment', async () => {
  await withFixture(async fx => {
    for (const operation of [() => fx.actions.revealArtwork(fx.command), () => fx.actions.createScene(fx.command, true),
      () => fx.actions.placePin(fx.command, 'scene', 'gm_only'),
      () => fx.actions.attachActor(fx.command, fx.actor.id, '', false, true)]) {
      await assert.rejects(operation(), /Use Attach token to actor/);
    }
    assert.equal(fx.checks.length + fx.fetches.length + fx.uploads.length + fx.updates.length, 0);
  });
});

test('token intent cannot bind generated token bytes to an older artwork pin', async () => {
  await withFixture(async fx => {
    const writes = [];
    const journal = { id: 'legacy-pin', ownership: { default: 0 }, pages: { contents: [{ type: 'image', src: PIN_ICON }] },
      flags: { [MODULE_ID]: { visibility: 'on_reveal' } }, async update(changes) { writes.push(changes); } };
    fx.world.journal.contents.push(journal);
    await assert.rejects(fx.actions.linkExistingPin(fx.command, journal.id), /Use Attach token to actor/);
    assert.deepEqual(writes, []);
  });
});

for (const creating of [false, true]) test(`${creating ? 'creation' : 'existing actor update'} shares overlapping work and caches successful attachment`, async () => {
  await withFixture(async fx => {
    let release, started;
    const pending = new Promise(resolve => { started = resolve; });
    fx.onUpload = () => { started(); return new Promise(resolve => { release = resolve; }); };
    const args = creating ? ['', 'npc'] : [fx.actor.id, ''];
    const first = fx.attach(...args); await pending;
    const overlap = fx.attach(...args);
    await assert.rejects(fx.attach('another-actor'), /already has an actor target/);
    release();
    const [one, two] = await Promise.all([first, overlap]);
    const repeated = await fx.attach(...args);
    assert.equal(one, two); assert.equal(repeated, one);
    assert.equal(fx.fetches.length, 1); assert.equal(fx.uploads.length, 1);
    assert.equal(fx.creates.length, creating ? 1 : 0); assert.equal(fx.updates.length, creating ? 0 : 1);
  });
});

test('a failed upload may retry before any document commit', async () => {
  await withFixture(async fx => {
    let attempts = 0;
    fx.onUpload = () => { if (++attempts === 1) throw Error('Synthetic upload failure'); };
    await assert.rejects(fx.attach('', 'npc'), /Synthetic upload failure/);
    assert.deepEqual(fx.creates, []);
    await fx.attach('', 'npc');
    assert.equal(attempts, 2); assert.equal(fx.creates.length, 1); assert.equal(fx.fetches.length, 1);
  });
});

for (const failure of ['create throws', 'create unconfirmed', 'update throws']) {
  test(`uncertain ${failure} blocks another document mutation on retry`, async () => {
    await withFixture(async fx => {
      const creating = failure.startsWith('create');
      if (creating) fx.onCreate = () => { if (failure === 'create unconfirmed') return null; throw Error('Connection lost after creation'); };
      else fx.onUpdate = () => { throw Error('Connection lost after update'); };
      const args = creating ? ['', 'npc'] : [fx.actor.id, ''];
      await assert.rejects(fx.attach(...args), /Token attachment is unconfirmed/);
      await assert.rejects(fx.attach(...args), /Token attachment is unconfirmed/);
      await assert.rejects(fx.attach('other-actor'), /already has an actor target/);
      assert.equal(fx.creates.length, creating ? 1 : 0); assert.equal(fx.updates.length, creating ? 0 : 1);
      assert.equal(fx.uploads.length, 1);
    });
  });
}

test('token command sanitizer preserves explicit intent and rejects mixed map assets or unknown intent', () => {
  const raw = rawCommand(), valid = validateWorkspaceCommand(raw);
  assert.equal(valid.intent, 'token'); assert.equal(valid.entry.image, IMAGE);
  assert.equal(valid.entry.artworkFingerprint, digest(PNG)); assert.equal(valid.entry.battlemapFingerprint, null);
  for (const change of [value => { value.intent = 'portrait'; }, value => { value.entry.battlemap = IMAGE; },
    value => { value.entry.battlemapFingerprint = 'b'.repeat(64); },
    value => { value.entry.artworkFingerprint = 'not-a-hash'; }]) {
    const invalid = rawCommand(); change(invalid); assert.equal(validateWorkspaceCommand(invalid), null);
  }
});

function controllerFixture(serverResponse) {
  const requests = [];
  const controller = new WorkspaceController({ getConfig: () => ({ token: 'a'.repeat(64), gmToken: 'b'.repeat(64) }),
    isCoordinator: () => true, openCommand: () => {}, isOnline: () => true,
    setTimer: () => 1, clearTimer: () => {}, fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body)); return Response.json(serverResponse);
    } });
  Object.assign(controller, { campaignId: CAMPAIGN, initialized: true, coordinator: true,
    readCode: 'a'.repeat(64), gmCode: 'b'.repeat(64) });
  return { controller, requests };
}

test('controller action check forwards token intent and accepts only the same token byte revision', async () => {
  const raw = rawCommand();
  const { controller, requests } = controllerFixture({ intent: 'token', entry: raw.entry });
  try {
    const fresh = await controller.checkAction(validateWorkspaceCommand(raw));
    assert.equal(fresh.intent, 'token'); assert.equal(fresh.entry.artworkFingerprint, digest(PNG));
    assert.deepEqual(requests.map(({ intent, artworkFingerprint, battlemapFingerprint }) => ({ intent, artworkFingerprint, battlemapFingerprint })),
      [{ intent: 'token', artworkFingerprint: digest(PNG), battlemapFingerprint: null }]);
  } finally { controller.stop(); }
});

test('controller rejects action-check intent downgrade, upgrade and changed token bytes', async () => {
  for (const kind of ['downgrade', 'upgrade', 'bytes']) {
    const raw = rawCommand(), reply = { intent: 'token', entry: { ...raw.entry } };
    if (kind === 'downgrade') delete reply.intent;
    if (kind === 'upgrade') delete raw.intent;
    if (kind === 'bytes') reply.entry.artworkFingerprint = 'b'.repeat(64);
    const { controller } = controllerFixture(reply);
    try { await assert.rejects(controller.checkAction(validateWorkspaceCommand(raw)), /artwork or map changed/); }
    finally { controller.stop(); }
  }
});
