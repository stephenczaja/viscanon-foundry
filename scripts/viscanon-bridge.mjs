import { BridgeController, MODULE_ID, SOCKET_NAME, TOKEN_PATTERN, normalizeCode } from './bridge-core.mjs';
import { WorkspaceController } from './workspace-core.mjs';
import { createWorkspaceActions } from './workspace-actions.mjs';
import { createWorkspaceApplication } from './workspace-ui.mjs';

let bridge;
let workspace;
let workspaceActions;
let settingsWindow;
let workspaceAccount = null;
const workspaceWindows = new Set();
const newWorkspaceActions = () => createWorkspaceActions({
  verifyPinVisibility: proof => workspace?.verifyPinVisibility(proof) ?? false,
  checkAction: command => {
    if (!workspace) throw new Error('The GM workspace connection is not ready.');
    return workspace.checkAction(command);
  }
});

function closeWorkspaceWindows() {
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
  // Workspace actions capture the GM ID. A newly signed-in GM needs a fresh
  // action controller; the old popup retains an unusable controller.
  if (workspaceActions) workspaceActions = newWorkspaceActions();
  workspace?.configure({ force: true });
  void clearForeignWorkspaceCode().catch(() => {
    ui.notifications.error('An old GM workspace code could not be removed from this browser. Clear this site’s local settings before another user signs in.');
  });
}

function updateStatusElement(element) {
  const status = bridge?.status ?? { state: 'starting', message: 'The world is starting. Try again when it is ready.' };
  element.dataset.state = status.state;
  element.querySelector('.viscanon-bridge-status-message').textContent = status.message;
  element.querySelector('.viscanon-bridge-status-check').hidden = status.state !== 'connected';
}

function updateWorkspaceStatusElement(element) {
  const status = workspace?.status ?? { state: 'starting', message: 'The world is starting. Try again when it is ready.' };
  element.dataset.state = status.state;
  element.textContent = status.message;
}

async function connect(code) {
  if (!game.user?.isGM) throw new Error('Only a GM can connect Viscanon.');
  const checked = await bridge.testCode(normalizeCode(code));
  // Bind the initial cursor to this code before publishing the code to clients.
  // Old Viscanon history is deliberately skipped on a new connection.
  await game.settings.set(MODULE_ID, 'checkpoint', checked);
  await game.settings.set(MODULE_ID, 'connectionCode', checked.token);
  bridge.configure();
  workspace?.configure();
}

async function disconnect() {
  if (!game.user?.isGM) throw new Error('Only a GM can disconnect Viscanon.');
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
      intro.textContent = 'In Viscanon, open Campaign Settings and create a Foundry connection code. Paste it here to show new reveals and shared memories to this world.';
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
      input.maxLength = 64;
      input.placeholder = config().token ? 'Connected code is saved. Paste a new code to replace it.' : 'Paste the code from Viscanon';
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
      note.textContent = 'Keep a GM connected to Foundry. Everyone in this world can receive the paired campaign’s shared artwork. The code grants read-only access to the bridge, so share this world only with its intended players.';
      const workspaceHeading = document.createElement('h2');
      workspaceHeading.textContent = 'Send to Foundry';
      const workspaceHelp = document.createElement('p');
      workspaceHelp.textContent = 'In Viscanon, create a GM workspace code for this campaign. Paste it on each GM account and browser that should receive Send to Foundry requests. The code is saved for this Foundry account in this browser and is never shared with players. Switching accounts clears it.';
      const workspaceStatus = document.createElement('p');
      workspaceStatus.className = 'viscanon-bridge-workspace-status';
      workspaceStatus.setAttribute('role', 'status');
      workspaceStatus.setAttribute('aria-live', 'polite');
      updateWorkspaceStatusElement(workspaceStatus);
      const workspaceLabel = document.createElement('label');
      workspaceLabel.textContent = 'GM workspace code';
      workspaceLabel.htmlFor = 'viscanon-bridge-workspace-code';
      const workspaceInput = document.createElement('input');
      workspaceInput.id = workspaceLabel.htmlFor;
      workspaceInput.type = 'password';
      workspaceInput.autocomplete = 'off';
      workspaceInput.spellcheck = false;
      workspaceInput.maxLength = 64;
      workspaceInput.placeholder = workspaceConfig().gmToken ? 'A GM workspace code is saved for this account.' : 'Paste the GM workspace code';
      const workspaceButtons = document.createElement('div');
      workspaceButtons.className = 'viscanon-bridge-buttons';
      for (const [action, text] of [['workspace-connect', 'Connect workspace'], ['workspace-check', 'Check workspace'], ['workspace-disconnect', 'Remove code']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.bridgeAction = action;
        button.textContent = text;
        workspaceButtons.append(button);
      }
      body.append(intro, status, label, input, buttons, note, workspaceHeading, workspaceHelp,
        workspaceStatus, workspaceLabel, workspaceInput, workspaceButtons);
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
              this.element.querySelector('#viscanon-bridge-code').value = '';
              ui.notifications.info('Viscanon connected. New artwork will appear in this world.');
            } else if (button.dataset.bridgeAction === 'disconnect') {
              await disconnect();
              ui.notifications.info('Viscanon disconnected from this world.');
            } else if (button.dataset.bridgeAction === 'workspace-connect') {
              await connectWorkspace(this.element.querySelector('#viscanon-bridge-workspace-code').value);
              this.element.querySelector('#viscanon-bridge-workspace-code').value = '';
              ui.notifications.info('GM workspace connected on this browser.');
            } else if (button.dataset.bridgeAction === 'workspace-disconnect') {
              await disconnectWorkspace();
              ui.notifications.info('GM workspace code removed from this browser.');
            } else if (button.dataset.bridgeAction === 'workspace-check') {
              workspace.configure({ force: true });
            } else {
              bridge.configure({ force: true });
            }
          } catch (error) {
            const message = error?.message || (error?.status === 401 || error?.status === 403
              ? 'That code is invalid or has been revoked. Create a new code in Viscanon.'
              : 'Could not connect. Check the code and try again.');
            ui.notifications.error(message);
          } finally {
            buttons.forEach(control => { control.disabled = false; });
            this.updateStatus();
          }
        });
      });
    }

    updateStatus() {
      const status = this.element?.querySelector('.viscanon-bridge-status');
      if (status) updateStatusElement(status);
      const workspaceStatus = this.element?.querySelector('.viscanon-bridge-workspace-status');
      if (workspaceStatus) updateWorkspaceStatusElement(workspaceStatus);
    }

    _onClose(options) {
      if (settingsWindow === this) settingsWindow = null;
      return super._onClose(options);
    }
  };
}

Hooks.once('init', () => {
  game.settings.register(MODULE_ID, 'connectionCode', {
    name: 'Viscanon connection code', hint: 'A read-only code for receiving campaign artwork.',
    scope: 'world', config: false, type: String, default: '',
    onChange: () => { closeWorkspaceWindows(); bridge?.configure(); workspace?.configure(); }
  });
  game.settings.register(MODULE_ID, 'workspaceCode', {
    name: 'Legacy GM workspace code', hint: 'Cleared when the updated module starts.',
    scope: 'client', config: false, type: String, default: '',
  });
  game.settings.register(MODULE_ID, 'workspaceCredential', {
    name: 'Private GM workspace credential', hint: 'Bound to this Foundry account in this browser for Send to Foundry.',
    scope: 'client', config: false, type: Object, default: {},
    onChange: () => { closeWorkspaceWindows(); workspace?.configure(); }
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
    get status() { return { ...bridge.status }; },
    get workspaceStatus() { return { ...workspace.status }; }
  });
  refreshWorkspaceAccount();
  bridge.configure();
  workspace.configure();
});
