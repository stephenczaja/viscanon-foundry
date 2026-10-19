import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_ENDPOINT } from '../scripts/bridge-core.mjs';
import { WorkspaceController, validateWorkspaceCommand } from '../scripts/workspace-core.mjs';
import { createWorkspaceActions, PIN_ICON, PIN_ICONS, sceneCreateData } from '../scripts/workspace-actions.mjs';
import { createWorkspaceApplication } from '../scripts/workspace-ui.mjs';

const CAMPAIGN = '10000000-0000-4000-8000-000000000001';
const ENTRY = '20000000-0000-4000-8000-000000000001';
const COMMAND = '30000000-0000-4000-8000-000000000001';
const READ_CODE = 'a'.repeat(64);
const GM_CODE = 'b'.repeat(64);
const RECEIVER = '40000000-0000-4000-8000-000000000001';
const NEXT_RECEIVER = '40000000-0000-4000-8000-000000000002';
const FINGERPRINT = 'c'.repeat(64);
const IMAGE_URL = `${new URL(DEFAULT_ENDPOINT).origin}/storage/v1/object/sign/artwork/campaign/image.webp?token=test-signature`;
const response = (body, status = 200) => ({ok: status >= 200 && status < 300, status, json: async () => body});

function command(overrides = {}) {
  return {
    id: COMMAND, action: 'open', campaignId: CAMPAIGN,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    entry: {
      id: ENTRY, title: 'Secret name', publicTitle: '', type: 'scene',
      chapter: 'Private chapter', chapterId: '50000000-0000-4000-8000-000000000001', category: 'scene',
      image: IMAGE_URL, battlemap: null, artworkFingerprint: FINGERPRINT,
      revealed: false
    }, ...overrides
  };
}

function idleTimers() {
  let serial = 0;
  const timers = new Map();
  return {
    timers,
    setTimer: (callback, delay) => { const id = ++serial; timers.set(id, {callback, delay}); return id; },
    clearTimer: id => { timers.delete(id); }
  };
}

test('a failed poll keeps its receiver session while the next nonce retires unfinished delivery', async () => {
  const timers = idleTimers(), opened = [];
  let serial = 0, serverSession = null, failPoll = false;
  const pending = [], failed = [];
  const controller = new WorkspaceController({
    getConfig: () => ({token: READ_CODE, gmToken: GM_CODE}), isCoordinator: () => true,
    randomUUID: () => [
      '40000000-0000-4000-8000-000000000000', RECEIVER, NEXT_RECEIVER
    ][serial++],
    openCommand: value => opened.push(value),
    fetchImpl: async (_, options) => {
      const body = JSON.parse(options.body);
      if (body.action === 'workspace-bootstrap') {
        if (serverSession !== body.session) failed.push(...pending.splice(0));
        serverSession = body.session;
        return response({connected: true, campaignId: CAMPAIGN});
      }
      if (body.session !== serverSession) return response({}, 409);
      if (body.action === 'workspace-poll') {
        // The real receive-slot RPC fails unfinished work from the prior nonce,
        // including when the same browser retains its receiver session.
        failed.push(...pending.filter(item => item.receiveNonce && item.receiveNonce !== body.receiveNonce));
        for (let i = pending.length - 1; i >= 0; --i) {
          if (pending[i].receiveNonce && pending[i].receiveNonce !== body.receiveNonce) pending.splice(i, 1);
        }
        for (const item of pending) item.receiveNonce = body.receiveNonce;
        if (failPoll) { failPoll = false; return response({}, 503); }
        return response({receiveNonce: body.receiveNonce,
          commands: [...pending], visiblePins: [], visiblePinArtwork: [], visiblePinFolders: []});
      }
      if (body.action === 'workspace-ack') {
        pending.splice(pending.findIndex(item => item.id === body.id), 1);
        return response({id: body.id, status: 'completed'});
      }
      throw Error('Unexpected request');
    },
    setTimer: timers.setTimer, clearTimer: timers.clearTimer
  });
  controller.configure();
  await controller.tick();
  pending.push(command());
  failPoll = true;
  await controller.tick();
  assert.equal(controller.status.state, 'retrying');
  assert.equal(controller.session, RECEIVER);
  await controller.tick();
  assert.deepEqual(failed.map(value => value.id), [COMMAND]);
  assert.deepEqual(opened, []);
  assert.equal(controller.status.state, 'connected');
  pending.push(command({id: '30000000-0000-4000-8000-000000000003'}));
  await controller.tick();
  assert.equal(opened.length, 1);
  controller.stop();
});

for (const failure of ['poll transport', 'pin reconciliation']) {
  test(`acknowledged popup action checks survive a recoverable ${failure} failure`, async () => {
    const timers = idleTimers(), opened = [], completed = new Map(), sessions = [];
    let serverSession, first = true, fail = false;
    const controller = new WorkspaceController({
      getConfig: () => ({token: READ_CODE, gmToken: GM_CODE}), isCoordinator: () => true,
      openCommand: value => opened.push(value),
      reconcilePins: async () => {
        if (fail && failure === 'pin reconciliation') { fail = false; throw Error('Synthetic Note update failed'); }
      },
      fetchImpl: async (_, options) => {
        const body = JSON.parse(options.body); sessions.push(body.session);
        if (body.action === 'workspace-bootstrap') {
          serverSession = body.session;
          return response({connected: true, campaignId: CAMPAIGN});
        }
        if (body.session !== serverSession) return response({}, 409);
        if (body.action === 'workspace-poll') {
          if (fail && failure === 'poll transport') { fail = false; return response({}, 503); }
          const commands = first ? [command()] : []; first = false;
          return response({receiveNonce: body.receiveNonce, commands,
            visiblePins: [], visiblePinArtwork: [], visiblePinFolders: []});
        }
        if (body.action === 'workspace-ack') {
          completed.set(body.id, body.session); return response({id: body.id, status: 'completed'});
        }
        if (body.action === 'workspace-action-check') {
          return completed.get(body.id) === body.session ? response({entry: command().entry}) : response({}, 404);
        }
        throw Error('Unexpected request');
      }, setTimer: timers.setTimer, clearTimer: timers.clearTimer
    });
    try {
      controller.configure(); await controller.tick();
      const receiver = controller.session;
      assert.equal(opened.length, 1);
      fail = true; await controller.tick();
      assert.equal(controller.status.state, 'retrying');
      await controller.tick();
      // Both Scene creation and Actor attachment repeatedly cross this guard.
      assert.equal((await controller.checkAction(opened[0])).id, COMMAND);
      assert.equal((await controller.checkAction(opened[0])).id, COMMAND);
      assert.equal(controller.session, receiver);
      assert.equal(opened.length, 1, 'recovery never opens a duplicate popup');
      assert.deepEqual(new Set(sessions), new Set([receiver]));
    } finally { controller.stop(); }
  });
}

