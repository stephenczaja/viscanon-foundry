import { BridgeController, BridgeHttpError, MODULE_ID, SOCKET_NAME, TOKEN_PATTERN, isCursor,
  normalizeCode, parsePairingCode } from './bridge-core.mjs';
import { WorkspaceController } from './workspace-core.mjs';
import { createWorkspaceActions } from './workspace-actions.mjs';
import { styleWorkspaceNote } from './workspace-pin.mjs';
import { createWorkspaceApplication } from './workspace-ui.mjs';
import { installPlayerDocumentNames } from './workspace-names.mjs';

let bridge;
let workspace;
let workspaceActions;
let settingsWindow;
let workspaceAccount = null;
let pairingTransition = false;
let pairingBusy = false;
const workspaceWindows = new Set();
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const newWorkspaceActions = () => createWorkspaceActions({
  fetchPinArtwork: proof => {
    if (!workspace) throw new Error('The GM workspace connection is not ready.');
    return workspace.fetchPinArtwork(proof);
  },
  revealViscanon: command => {
    if (!workspace) throw new Error('The GM workspace connection is not ready.');
    return workspace.revealArtwork(command);
  },
  shareReveal: async receipt => {
    if (!bridge || !game.user?.isGM || game.users.activeGM?.id !== game.user.id) {
      throw new Error('Revealed in Viscanon. The Foundry receiver will display it when connected.');
    }
    const packet = { type: 'artwork', id: receipt.eventId };
    game.socket.emit(SOCKET_NAME, packet);
    void bridge.receive(packet).catch(() => ui.notifications.warn('Revealed in Viscanon. Foundry is retrying the artwork display.'));
    bridge.wake(); workspace?.wake();
  },
  verifyPinVisibility: proof => workspace?.verifyPinVisibility(proof) ?? false,
  checkAction: command => {
    if (!workspace) throw new Error('The GM workspace connection is not ready.');
    return workspace.checkAction(command);
  }
});

function closeWorkspaceWindows() {
  // Retire in-flight private work and bind subsequent actions to the current
  // account. Settings changes also take this path, even without an account switch.
  if (workspaceActions) { workspaceActions.destroy(); workspaceActions = newWorkspaceActions(); }
  for (const app of [...workspaceWindows]) {
    // Hide private command details immediately; ApplicationV2.close may await animation.
    if (app.element) app.element.hidden = true;
    workspaceWindows.delete(app);
    try { void Promise.resolve(app.close()).catch(() => {}); }
    catch { /* A closing world can already have torn down the window. */ }
  }
}

function closeSettingsWindow() {
  const app = settingsWindow;
  if (!app) return;
  settingsWindow = null;
  // The settings form can hold a code that has been pasted but not saved yet.
  // Clear it before the asynchronous window close can show it to a new account.
  for (const id of ['#viscanon-bridge-code', '#viscanon-bridge-workspace-code']) {
    const input = app.element?.querySelector?.(id);
    if (input) input.value = '';
  }
  if (app.element) app.element.hidden = true;
  try { void Promise.resolve(app.close()).catch(() => {}); }
  catch { /* A closing world can already have torn down the window. */ }
}

const config = () => ({
  token: game.settings.get(MODULE_ID, 'connectionCode'),
  checkpoint: game.settings.get(MODULE_ID, 'checkpoint')
});

function currentWorkspaceCredential() {
  const credential = game.settings.get(MODULE_ID, 'workspaceCredential');
  return game.user?.isGM && game.user?.id && credential?.ownerId === game.user.id
    ? credential : null;
}

const workspaceConfig = () => ({
  token: game.settings.get(MODULE_ID, 'connectionCode'),
  gmToken: currentWorkspaceCredential()?.token ?? ''
});

async function clearForeignWorkspaceCode() {
  // The previous client setting had no account binding. Never promote it into
  // an account-bound credential, even when this browser is currently a GM.
  if (game.settings.get(MODULE_ID, 'workspaceCode')) {
    await game.settings.set(MODULE_ID, 'workspaceCode', '');
  }
  const credential = game.settings.get(MODULE_ID, 'workspaceCredential');
  if (credential && Object.keys(credential).length
    && (!currentWorkspaceCredential() || !TOKEN_PATTERN.test(normalizeCode(credential.token)))) {
    await game.settings.set(MODULE_ID, 'workspaceCredential', {});
  }
}

function refreshWorkspaceAccount() {
  const account = game.user?.isGM ? game.user.id ?? '' : '';
  if (account === workspaceAccount) return;
  workspaceAccount = account;
  closeWorkspaceWindows();
  closeSettingsWindow();
  workspace?.configure({ force: true });
  void clearForeignWorkspaceCode().catch(() => {
    ui.notifications.error('An old GM workspace code could not be removed from this browser. Clear this site’s local settings before another user signs in.');
  });
}

function updateStatusElement(element) {
  const status = connectionStatus();
  const fullyConnected = status.state === 'connected' && Boolean(currentWorkspaceCredential())
    && workspace?.status.state === 'connected';
  element.dataset.state = status.state;
  element.dataset.capability = fullyConnected ? 'full' : 'partial';
  element.querySelector('.viscanon-bridge-status-message').textContent = status.message;
  element.querySelector('.viscanon-bridge-status-check').hidden = !fullyConnected;
}

function connectionStatus() {
  const artwork = bridge?.status ?? { state: 'starting', message: 'The world is starting. Try again when it is ready.' };
  if (artwork.state !== 'connected') return { ...artwork };
  if (!currentWorkspaceCredential()) return { state: 'connected', message:
    'Artwork connected. Send to Foundry is unavailable on this GM browser; pair with a new VC2 code to enable it.' };
  const send = workspace?.status;
  if (send?.state === 'connected') return { state: 'connected', message: 'Connected. Artwork and Send to Foundry are ready.' };
  if (send?.state === 'listening') return { state: 'connected', message:
    'Artwork connected. The active GM receives Send to Foundry requests.' };
  return { state: send?.state || 'connecting', message:
    `Artwork connected. Send to Foundry is unavailable: ${send?.message || 'Checking the GM connection…'}` };
}

async function pairingRequest(paired, body, assertOwner) {
  assertOwner();
  const controller = new AbortController();
  const timeout = bridge.setTimer(() => controller.abort(), 15000);
  try {
    const response = await bridge.fetchImpl(bridge.endpoint, {
      method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Viscanon-Token': paired.token,
        'X-Viscanon-GM-Token': paired.gmToken },
      body: JSON.stringify(body), signal: controller.signal
    });
    assertOwner();
    if (!response.ok) throw new BridgeHttpError(response.status);
    const data = await response.json();
    assertOwner();
    return data;
  } finally {
    bridge.clearTimer(timeout);
  }
}

function validProbe(data) {
  return UUID_PATTERN.test(data?.campaignId ?? '') && UUID_PATTERN.test(data?.pendingId ?? '')
    && UUID_PATTERN.test(data?.challenge ?? '') && isCursor(data?.cursor)
    && typeof data?.expiresAt === 'string'
    && Number.isFinite(Date.parse(data.expiresAt)) && Date.parse(data.expiresAt) > Date.now() + 30000;
}

function validActivation(data, probe) {
  return data?.connected === true && data?.gmKeyConfigured === true
    && data?.pendingId === probe.pendingId && data?.campaignId === probe.campaignId
    && UUID_PATTERN.test(data?.connection?.id ?? '') && isCursor(data?.cursor);
}

function definiteActivationRejection(error) {
  return error instanceof BridgeHttpError && [400, 401, 403, 404, 409, 410, 422].includes(error.status);
}

async function activatePairing(paired, probe, previousRead, previousCredential, assertOwner) {
  const body = { action: 'pairing-activate', pendingId: probe.pendingId, challenge: probe.challenge };
  let firstFailure;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const receipt = await pairingRequest(paired, body, assertOwner);
      if (!validActivation(receipt, probe)) throw new Error('The bridge returned an invalid activation receipt.');
      return receipt;
    } catch (error) {
      if (attempt === 0 && definiteActivationRejection(error)) throw error;
      firstFailure ??= error;
      if (attempt === 0) continue;
    }
  }
  // A lost response can follow a committed activation. Confirm both halves of
  // the new pair before deciding whether to restore the old local connection.
  try {
    assertOwner();
    await bridge.testCode(paired.token);
    await workspace.testCode(paired.gmToken, paired.token);
    assertOwner();
    // Bootstrap reports the *current* feed head. A reveal may have arrived
    // after activation, so keep the pre-activation checkpoint; SQL clamps it
    // to the new connection's start sequence when polling resumes.
    return { connected: true, gmKeyConfigured: true, pendingId: probe.pendingId,
      campaignId: probe.campaignId, connection: { id: probe.pendingId }, cursor: probe.cursor };
  } catch {
    // If the candidate is absent but the complete previous pair is still
    // accepted, the activation did not replace it and local rollback is safe.
    if (TOKEN_PATTERN.test(previousRead)) {
      try {
        assertOwner();
        await bridge.testCode(previousRead);
        if (previousCredential?.token) await workspace.testCode(previousCredential.token, previousRead);
        assertOwner();
        const error = new Error('The pending pairing was not activated. The previous connection is still active.');
        error.previousPairConfirmed = true;
        throw error;
      } catch (error) {
        if (error?.previousPairConfirmed) throw error;
      }
    }
    const error = new Error('Pairing activation could not be confirmed. Check this connection when network access returns.');
    error.uncertainPairing = true;
    error.cause = firstFailure;
    throw error;
  }
}

async function connectStagedPair(paired, ownerId) {
  if (pairingBusy) throw new Error('A Viscanon pairing is already in progress.');
  pairingBusy = true;
  try { return await connectStagedPairLocked(paired, ownerId); }
  finally { pairingBusy = false; }
}

async function connectStagedPairLocked(paired, ownerId) {
  const assertOwner = () => {
    if (!game.user?.isGM || game.user.id !== ownerId) {
      throw new Error('The Foundry account changed while pairing. Paste the code again.');
    }
  };
  const beforeProbeRead = normalizeCode(config().token);
  const probe = await pairingRequest(paired, { action: 'pairing-probe' }, assertOwner);
  if (!validProbe(probe)) throw new Error('The bridge did not confirm a pending connection for this Foundry world.');
  assertOwner();
  if (normalizeCode(config().token) !== beforeProbeRead) {
    throw new Error('The Foundry connection changed while checking this code. Create a new code in Viscanon.');
  }
  const previousRead = normalizeCode(config().token);
  const previousCheckpoint = config().checkpoint;
  const previousCredential = currentWorkspaceCredential();
  const nextCredential = { ownerId, token: paired.gmToken };
  let activationStarted = false;
  let activationConfirmed = false;
  pairingTransition = true;
  bridge.stop();
  workspace.stop();
  bridge.setStatus('connecting', 'Completing the Viscanon pairing…');
  workspace.setStatus('connecting', 'Completing the Viscanon pairing…');
  try {
    // Stage locally only after the loaded receiver proves it can parse VC2.
    // The old backend connection remains active until pairing-activate commits.
    await game.settings.set(MODULE_ID, 'workspaceCredential', nextCredential);
    assertOwner();
    await game.settings.set(MODULE_ID, 'checkpoint', { token: paired.token, cursor: probe.cursor });
    assertOwner();
    if (normalizeCode(config().token) !== previousRead) {
      throw new Error('The Foundry connection changed while saving this code. Create a new code in Viscanon.');
    }
    await game.settings.set(MODULE_ID, 'connectionCode', paired.token);
    assertOwner();
    activationStarted = true;
    const receipt = await activatePairing(paired, probe, previousRead, previousCredential, assertOwner);
    activationConfirmed = true;
    assertOwner();
    await game.settings.set(MODULE_ID, 'checkpoint', { token: paired.token, cursor: receipt.cursor });
    assertOwner();
  } catch (error) {
    // Once activation may have committed, restoring an old code could strand
    // this world on a revoked capability. Keep the candidate for recovery.
    if (activationStarted && (activationConfirmed || error?.uncertainPairing)) throw error;
    const restoreFailures = [];
    if (game.user?.isGM && game.user.id === ownerId) {
      if (config().token === paired.token && previousRead !== paired.token) {
        try { await game.settings.set(MODULE_ID, 'connectionCode', previousRead); }
        catch { restoreFailures.push('world connection code'); }
      }
      if (config().checkpoint?.token === paired.token) {
        try { await game.settings.set(MODULE_ID, 'checkpoint', previousCheckpoint); }
        catch { restoreFailures.push('world delivery position'); }
      }
    }
    const stored = game.settings.get(MODULE_ID, 'workspaceCredential');
    if (stored?.ownerId === ownerId && stored.token === paired.gmToken) {
      try { await game.settings.set(MODULE_ID, 'workspaceCredential',
        game.user?.isGM && game.user.id === ownerId ? previousCredential ?? {} : {}); }
      catch { restoreFailures.push('private GM credential'); }
    }
    if (restoreFailures.length) {
      let previousPairActive = error?.previousPairConfirmed === true;
      if (!previousPairActive && game.user?.isGM && game.user.id === ownerId
        && TOKEN_PATTERN.test(previousRead)) {
        try {
          await bridge.testCode(previousRead);
          if (previousCredential?.token) await workspace.testCode(previousCredential.token, previousRead);
          previousPairActive = true;
        } catch { /* Report the local repair need without claiming server status. */ }
      }
      const message = previousPairActive
        ? 'The previous Viscanon server pair is still active, but Foundry could not restore its local settings. Repair this world’s connection before trying again.'
        : 'The new Viscanon pair was not confirmed, and Foundry could not restore its local settings. Check and repair this world’s connection before trying again.';
      const recoveryError = new Error(message, { cause: error });
      recoveryError.restoreFailures = restoreFailures;
      throw recoveryError;
    }
    throw error;
  } finally {
    pairingTransition = false;
    bridge.configure({ force: true });
    workspace.configure({ force: true });
  }
}

async function connect(code) {
  const ownerId = game.user?.isGM ? game.user.id : '';
  if (!ownerId) throw new Error('Only a GM can connect Viscanon.');
  const paired = parsePairingCode(code);
  if (!paired.legacy) return connectStagedPair(paired, ownerId);
  const checked = await bridge.testCode(paired.token);
  if (paired.gmToken) await workspace.testCode(paired.gmToken, checked.token);
  const assertOwner = () => {
    if (!game.user?.isGM || game.user.id !== ownerId) {
      throw new Error('The Foundry account changed while pairing. Paste the code again.');
    }
  };
  assertOwner();
  const previousRead = normalizeCode(config().token);
  const previousCheckpoint = config().checkpoint;
  const previousCredential = currentWorkspaceCredential();
  const nextCredential = paired.gmToken ? { ownerId, token: paired.gmToken }
    : previousRead === checked.token ? previousCredential : null;
  let credentialWritten = false;
  try {
    // Client scope is account-bound. Never store the bundled code, or its GM
    // half, in the world-readable connectionCode or checkpoint settings.
    await game.settings.set(MODULE_ID, 'workspaceCredential', nextCredential ?? {});
    credentialWritten = true;
    assertOwner();
    // Bind the initial cursor to this code before publishing the read half to
    // clients. Old Viscanon history is deliberately skipped on a new pair.
    await game.settings.set(MODULE_ID, 'checkpoint', checked);
    assertOwner();
    await game.settings.set(MODULE_ID, 'connectionCode', checked.token);
    assertOwner();
  } catch (error) {
    // A failed world-setting write must not leave a newly supplied GM token on
    // this browser. Account switching also clears the client setting.
    const stored = game.settings.get(MODULE_ID, 'workspaceCredential');
    if (credentialWritten && stored?.ownerId === ownerId && stored?.token === nextCredential?.token) {
      const sameGM = game.user?.isGM && game.user.id === ownerId;
      try { await game.settings.set(MODULE_ID, 'workspaceCredential', sameGM ? previousCredential ?? {} : {}); }
      catch { /* Preserve the pairing error; account-switch cleanup retries. */ }
    }
    // Only the original GM may restore world settings. Guard the values so a
    // concurrent connection made by another GM is not overwritten.
    if (game.user?.isGM && game.user.id === ownerId) {
      if (config().token === checked.token && previousRead !== checked.token) {
        try { await game.settings.set(MODULE_ID, 'connectionCode', previousRead); }
        catch { /* Preserve the pairing error. */ }
      }
      if (config().checkpoint?.token === checked.token) {
        try { await game.settings.set(MODULE_ID, 'checkpoint', previousCheckpoint); }
        catch { /* Preserve the pairing error. */ }
      }
    }
    throw error;
  }
  bridge.configure();
  workspace?.configure();
}

async function disconnect() {
  if (!game.user?.isGM) throw new Error('Only a GM can disconnect Viscanon.');
  await game.settings.set(MODULE_ID, 'workspaceCredential', {});
  await game.settings.set(MODULE_ID, 'connectionCode', '');
  await game.settings.set(MODULE_ID, 'checkpoint', {});
  bridge.configure();
  workspace?.configure();
}

async function connectWorkspace(code) {
  const ownerId = game.user?.isGM ? game.user.id : '';
  if (!ownerId) throw new Error('Only a signed-in GM can connect a workspace code.');
  const token = await workspace.testCode(code);
  if (!game.user?.isGM || game.user.id !== ownerId) {
    throw new Error('The Foundry account changed while the GM code was being checked. Paste the code again.');
  }
  await game.settings.set(MODULE_ID, 'workspaceCredential', { ownerId, token });
  if (!game.user?.isGM || game.user.id !== ownerId) {
    const stored = game.settings.get(MODULE_ID, 'workspaceCredential');
    if (stored?.ownerId === ownerId && stored.token === token) {
      await game.settings.set(MODULE_ID, 'workspaceCredential', {});
    }
    throw new Error('The Foundry account changed while the GM code was being checked. Paste the code again.');
  }
  // Clear an unbound v0.2 code after storing the new, account-bound credential.
  if (game.settings.get(MODULE_ID, 'workspaceCode')) {
    await game.settings.set(MODULE_ID, 'workspaceCode', '');
  }
  workspace.configure();
}

async function disconnectWorkspace() {
  if (!game.user?.isGM) throw new Error('Only a GM can disconnect a workspace code.');
  await game.settings.set(MODULE_ID, 'workspaceCredential', {});
  if (game.settings.get(MODULE_ID, 'workspaceCode')) {
    await game.settings.set(MODULE_ID, 'workspaceCode', '');
  }
  workspace.configure();
}

function createSettingsApplication() {
  return class ViscanonSettings extends foundry.applications.api.ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: 'viscanon-bridge-settings',
      classes: ['viscanon-bridge-settings'],
      window: { title: 'Viscanon', resizable: false },
      position: { width: 440 }
    };

    async _renderHTML() {
      const content = document.createElement('div');
      content.className = 'viscanon-bridge-content';
      const banner = document.createElement('div');
      banner.className = 'viscanon-bridge-banner';
      const logo = document.createElement('img');
      logo.className = 'viscanon-bridge-logo';
      logo.src = `modules/${MODULE_ID}/assets/viscanon-mark-white.svg`;
      logo.alt = 'Viscanon';
      logo.width = 160;
      logo.height = 81;
      banner.append(logo);
      const body = document.createElement('div');
      body.className = 'viscanon-bridge-body';
      const intro = document.createElement('p');
      intro.textContent = 'In Viscanon Campaign Settings, create a Foundry connection code. Paste it here once to pair this world for artwork and Send to Foundry.';
      const status = document.createElement('p');
      status.className = 'viscanon-bridge-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      const message = document.createElement('span');
      message.className = 'viscanon-bridge-status-message';
      const check = document.createElement('span');
      check.className = 'viscanon-bridge-status-check';
      check.setAttribute('aria-hidden', 'true');
      check.textContent = '✓';
      status.append(message, check);
      updateStatusElement(status);
      const label = document.createElement('label');
      label.textContent = 'Connection code';
      label.htmlFor = 'viscanon-bridge-code';
      const input = document.createElement('input');
      input.id = label.htmlFor;
      input.type = 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.maxLength = 133;
      input.placeholder = config().token ? 'Paste a new code to replace this connection' : 'Paste the code from Viscanon';
      const buttons = document.createElement('div');
      buttons.className = 'viscanon-bridge-buttons';
      for (const [action, text] of [['connect', 'Connect'], ['retry', 'Check connection'], ['disconnect', 'Disconnect']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.bridgeAction = action;
        button.textContent = text;
        buttons.append(button);
      }
      const note = document.createElement('p');
      note.className = 'viscanon-bridge-note';
      note.textContent = 'Keep an active GM online for Send to Foundry. Shared artwork is available to this world’s players. The private Send credential stays in this GM account’s browser and is cleared if the account changes. A legacy 64-character code alone receives artwork only.';
      body.append(intro, status, label, input, buttons, note);
      content.append(banner, body);
      return content;
    }

    _replaceHTML(result, content) {
      content.replaceChildren(result);
    }

    _onRender(context, options) {
      super._onRender(context, options);
      settingsWindow = this;
      this.element.querySelectorAll('[data-bridge-action]').forEach(button => {
        button.addEventListener('click', async () => {
          if (!game.user?.isGM || !bridge) return;
          const buttons = this.element.querySelectorAll('[data-bridge-action]');
          buttons.forEach(control => { control.disabled = true; });
          try {
            if (button.dataset.bridgeAction === 'connect') {
              await connect(this.element.querySelector('#viscanon-bridge-code').value);
              ui.notifications.info('Viscanon pairing saved. Checking the connection…');
            } else if (button.dataset.bridgeAction === 'disconnect') {
              await disconnect();
              ui.notifications.info('Viscanon disconnected from this world.');
            } else {
              bridge.configure({ force: true });
              workspace.configure({ force: true });
            }
          } catch (error) {
            const message = error?.status === 401 || error?.status === 403
              ? 'That code is invalid or has been revoked. Create a new code in Viscanon.'
              : error?.message || 'Could not connect. Check the code and try again.';
            ui.notifications.error(message);
          } finally {
            const input = this.element?.querySelector('#viscanon-bridge-code');
            if (input) input.value = '';
            buttons.forEach(control => { control.disabled = false; });
            this.updateStatus();
          }
        });
      });
    }

    updateStatus() {
      const status = this.element?.querySelector('.viscanon-bridge-status');
      if (status) updateStatusElement(status);
    }

    _onClose(options) {
      if (settingsWindow === this) settingsWindow = null;
      return super._onClose(options);
    }
  };
}

Hooks.once('init', () => {
  installPlayerDocumentNames();
  game.settings.register(MODULE_ID, 'connectionCode', {
    name: 'Viscanon connection code', hint: 'A read-only code for receiving campaign artwork.',
    scope: 'world', config: false, type: String, default: '',
    onChange: () => { closeWorkspaceWindows(); if (!pairingTransition) { bridge?.configure(); workspace?.configure(); } }
  });
  game.settings.register(MODULE_ID, 'workspaceCode', {
    name: 'Legacy GM workspace code', hint: 'Cleared when the updated module starts.',
    scope: 'client', config: false, type: String, default: '',
  });
  game.settings.register(MODULE_ID, 'workspaceCredential', {
    name: 'Private GM workspace credential', hint: 'Bound to this Foundry account in this browser for Send to Foundry.',
    scope: 'client', config: false, type: Object, default: {},
    onChange: () => { closeWorkspaceWindows(); if (!pairingTransition) workspace?.configure(); }
  });
  game.settings.register(MODULE_ID, 'checkpoint', {
    name: 'Viscanon delivery position', hint: 'The last received position for the current code.',
    scope: 'world', config: false, type: Object, default: {}
  });
  game.settings.registerMenu(MODULE_ID, 'connection', {
    name: 'Viscanon', label: 'Connect to Viscanon',
    hint: 'Receive reveals and shared memories from a Viscanon campaign.',
    icon: 'fa-solid fa-eye', type: createSettingsApplication(), restricted: true
  });
});

Hooks.once('ready', () => {
  workspaceActions = newWorkspaceActions();
  bridge = new BridgeController({
    getConfig: config,
    isCoordinator: () => Boolean(game.user?.isGM && game.users.activeGM?.id === game.user.id),
    saveCheckpoint: async checkpoint => {
      if (game.user?.isGM && checkpoint.token === config().token) {
        const current = config().checkpoint;
        if (current?.token !== checkpoint.token || current.cursor !== checkpoint.cursor) {
          await game.settings.set(MODULE_ID, 'checkpoint', checkpoint);
        }
      }
    },
    broadcast: packet => game.socket.emit(SOCKET_NAME, packet),
    display: async event => {
      if (event.type === 'reveal' && game.user?.isGM && game.users.activeGM?.id === game.user.id) {
        // Workspace reconciliation verifies the current artwork fingerprint before
        // exposing a pin. The read-only reveal event alone is not sufficient.
        workspace?.wake();
      }
      const ImagePopout = foundry.applications.apps.ImagePopout;
      await new ImagePopout({
        classes: [...(ImagePopout.DEFAULT_OPTIONS?.classes ?? []), 'viscanon-bridge-artwork'],
        src: event.imageUrl, showTitle: true, window: { title: event.title }
      }).render({ force: true });
    },
    onStatus: () => settingsWindow?.updateStatus()
  });
  workspace = new WorkspaceController({
    getConfig: workspaceConfig,
    isCoordinator: () => Boolean(currentWorkspaceCredential() && game.users.activeGM?.id === game.user.id),
    isOnline: () => globalThis.navigator?.onLine !== false && game.socket?.connected === true,
    getPins: campaignId => workspaceActions.getPins(campaignId),
    reconcilePins: payload => workspaceActions.reconcilePins(payload),
    openCommand: async command => {
      const credential = currentWorkspaceCredential();
      if (!credential || game.users.activeGM?.id !== credential.ownerId) {
        throw new Error('This GM workspace request is no longer authorized for this account.');
      }
      const authorized = () => game.user?.id === credential.ownerId
        && game.users.activeGM?.id === credential.ownerId
        && currentWorkspaceCredential()?.token === credential.token;
      workspaceActions.assertFresh(command);
      let app;
      const Application = createWorkspaceApplication(command, workspaceActions,
        () => workspaceWindows.delete(app), authorized,
        current => workspace.checkAction(current));
      app = new Application({ id: `viscanon-workspace-${command.id}` });
      workspaceWindows.add(app);
      try {
        await app.render({ force: true });
        workspaceActions.assertFresh(command);
        if (!authorized()) {
          throw new Error('The Foundry account or GM workspace code changed while this request opened.');
        }
      }
      catch (error) {
        workspaceWindows.delete(app);
        try { await app.close(); } catch { /* Preserve the original error. */ }
        throw error;
      }
    },
    onStatus: () => settingsWindow?.updateStatus()
  });
  game.socket.on(SOCKET_NAME, packet => {
    void bridge.receive(packet).catch(() => {
      ui.notifications.warn('Viscanon artwork could not be loaded. Check your connection.');
    });
  });
  game.socket.on('disconnect', () => workspace.wake());
  game.socket.on('connect', () => workspace.wake());
  Hooks.on('drawNote', styleWorkspaceNote);
  Hooks.on('refreshNote', styleWorkspaceNote);
  Hooks.on('activateNote', note => workspaceActions?.activatePin(note));
  Hooks.on('userConnected', () => { refreshWorkspaceAccount(); bridge.configure(); workspace.configure(); });
  Hooks.on('updateUser', () => { refreshWorkspaceAccount(); bridge.configure(); workspace.configure(); });
  globalThis.addEventListener('online', () => { refreshWorkspaceAccount(); bridge.wake(); workspace.wake(); });
  globalThis.addEventListener('offline', () => { refreshWorkspaceAccount(); bridge.wake(); workspace.wake(); });
  globalThis.addEventListener('beforeunload', () => { bridge.destroy(); workspace.stop(); }, { once: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { refreshWorkspaceAccount(); bridge.wake(); workspace.wake(); }
  });
  game.modules.get(MODULE_ID).api = Object.freeze({
    connect, disconnect, connectWorkspace, disconnectWorkspace,
    get status() { return connectionStatus(); },
    get workspaceStatus() { return { ...workspace.status }; }
  });
  refreshWorkspaceAccount();
  bridge.configure();
  workspace.configure();
});
