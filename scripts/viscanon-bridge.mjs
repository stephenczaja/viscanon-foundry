import { BridgeController, MODULE_ID, SOCKET_NAME, normalizeCode } from './bridge-core.mjs';

let bridge;
let settingsWindow;

const config = () => ({
  token: game.settings.get(MODULE_ID, 'connectionCode'),
  checkpoint: game.settings.get(MODULE_ID, 'checkpoint')
});

function updateStatusElement(element) {
  const status = bridge?.status ?? { state: 'starting', message: 'The world is starting. Try again when it is ready.' };
  element.dataset.state = status.state;
  element.querySelector('.viscanon-bridge-status-message').textContent = status.message;
  element.querySelector('.viscanon-bridge-status-check').hidden = status.state !== 'connected';
}

async function connect(code) {
  if (!game.user?.isGM) throw new Error('Only a GM can connect Viscanon.');
  const checked = await bridge.testCode(normalizeCode(code));
  // Bind the initial cursor to this code before publishing the code to clients.
  // Old Viscanon history is deliberately skipped on a new connection.
  await game.settings.set(MODULE_ID, 'checkpoint', checked);
  await game.settings.set(MODULE_ID, 'connectionCode', checked.token);
  bridge.configure();
}

async function disconnect() {
  if (!game.user?.isGM) throw new Error('Only a GM can disconnect Viscanon.');
  await game.settings.set(MODULE_ID, 'connectionCode', '');
  await game.settings.set(MODULE_ID, 'checkpoint', {});
  bridge.configure();
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
              this.element.querySelector('#viscanon-bridge-code').value = '';
              ui.notifications.info('Viscanon connected. New artwork will appear in this world.');
            } else if (button.dataset.bridgeAction === 'disconnect') {
              await disconnect();
              ui.notifications.info('Viscanon disconnected from this world.');
            } else {
              bridge.configure({ force: true });
            }
          } catch (error) {
            const message = error?.status === 401 || error?.status === 403
              ? 'That code is invalid or has been revoked. Create a new code in Viscanon.'
              : 'Could not connect. Check the connection code and try again.';
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
    onChange: () => bridge?.configure()
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
      const ImagePopout = foundry.applications.apps.ImagePopout;
      await new ImagePopout({
        classes: [...(ImagePopout.DEFAULT_OPTIONS?.classes ?? []), 'viscanon-bridge-artwork'],
        src: event.imageUrl, showTitle: true, window: { title: event.title }
      }).render({ force: true });
    },
    onStatus: () => settingsWindow?.updateStatus()
  });
  game.socket.on(SOCKET_NAME, packet => {
    void bridge.receive(packet).catch(() => {
      ui.notifications.warn('Viscanon artwork could not be loaded. Check your connection.');
    });
  });
  Hooks.on('userConnected', () => bridge.configure());
  Hooks.on('updateUser', () => bridge.configure());
  globalThis.addEventListener('online', () => bridge.wake());
  globalThis.addEventListener('offline', () => bridge.wake());
  globalThis.addEventListener('beforeunload', () => bridge.destroy(), { once: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') bridge.wake();
  });
  game.modules.get(MODULE_ID).api = Object.freeze({
    connect, disconnect,
    get status() { return { ...bridge.status }; }
  });
  bridge.configure();
});
