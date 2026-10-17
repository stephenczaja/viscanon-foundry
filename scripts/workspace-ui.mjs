import { MODULE_ID } from './bridge-core.mjs';
import { PIN_VISIBILITY } from './workspace-actions.mjs';

function make(tag, text = '', className = '') {
  const element = document.createElement(tag);
  element.textContent = text;
  if (className) element.className = className;
  return element;
}

function option(value, text) {
  const item = make('option', text);
  item.value = value;
  return item;
}

export function createWorkspaceApplication(command, actions, onClose = () => {}, isAuthorized = () => true,
  checkAction = async () => { throw new Error('Foundry cannot verify this request.'); }) {
  const { entry } = command;
  return class ViscanonWorkspace extends foundry.applications.api.ApplicationV2 {
    static DEFAULT_OPTIONS = {
      classes: ['viscanon-bridge-workspace'],
      window: { title: 'Send to Foundry', resizable: true },
      position: { width: 520 }
    };

    async _renderHTML() {
      if (!isAuthorized()) throw new Error('This GM workspace request is no longer authorized for this account.');
      const content = make('div', '', 'viscanon-bridge-workspace-content');
      const header = make('div', '', 'viscanon-bridge-workspace-header');
      const logo = make('img');
      logo.src = `modules/${MODULE_ID}/assets/viscanon-mark-white.svg`;
      logo.alt = 'Viscanon';
      header.append(logo);
      const body = make('div', '', 'viscanon-bridge-workspace-body');
      body.append(make('h2', entry.title), make('p', `${entry.type || 'Entry'}${entry.chapter ? ` · ${entry.chapter}` : ''}${entry.category ? ` · ${entry.category}` : ''}`, 'viscanon-bridge-workspace-meta'));
      const preview = make('img', '', 'viscanon-bridge-workspace-preview');
      preview.src = entry.image;
      preview.alt = `GM preview of ${entry.title}`;
      body.append(preview);
      const feedback = make('p', 'Choose what to send to this Foundry world.', 'viscanon-bridge-workspace-feedback');
      feedback.setAttribute('role', 'status');
      feedback.setAttribute('aria-live', 'polite');
      body.append(feedback);

      const reveal = make('section', '', 'viscanon-bridge-workspace-section');
      reveal.append(make('h3', 'Reveal artwork'), make('p', 'Show this artwork to everyone connected to Foundry. Anyone with the saved Foundry file URL may fetch it after this window closes. This does not change its Viscanon reveal state.'));
      const revealButton = make('button', 'Reveal artwork to players');
      revealButton.type = 'button'; revealButton.dataset.workspaceAction = 'reveal';
      reveal.append(revealButton);

      const pin = make('section', '', 'viscanon-bridge-workspace-section');
      pin.append(make('h3', 'Place map pin'), make('p', 'Choose a scene, then click the map to place the Viscanon eye. Will appear on reveal keeps artwork out of Foundry file storage until a matching Viscanon reveal is confirmed or you choose Reveal artwork here. Either action uploads it to publicly readable storage. Visible to players uploads now. Anyone with the saved Foundry file URL may fetch it later even if the pin is hidden.'));
      const sceneLabel = make('label', 'Scene');
      const scene = make('select'); scene.dataset.workspaceField = 'scene';
      for (const item of game.scenes?.contents ?? []) scene.append(option(item.id, item.name));
      if (game.scenes?.current?.id) scene.value = game.scenes.current.id;
      sceneLabel.append(scene);
      const visibilityLabel = make('label', 'Pin visibility');
      const visibility = make('select'); visibility.dataset.workspaceField = 'visibility';
      visibility.append(
        option(PIN_VISIBILITY.onReveal, 'Will appear on reveal'),
        option(PIN_VISIBILITY.gmOnly, 'GM only'),
        option(PIN_VISIBILITY.visible, 'Visible to players')
      );
      visibility.value = PIN_VISIBILITY.onReveal;
      visibilityLabel.append(visibility);
      const pinButton = make('button', 'Place map pin');
      pinButton.type = 'button'; pinButton.dataset.workspaceAction = 'pin';
      pinButton.disabled = !scene.options.length;
      pin.append(sceneLabel, visibilityLabel, pinButton);

      const map = make('section', '', 'viscanon-bridge-workspace-section');
      map.append(make('h3', 'Create scene'), make('p', 'Create a gridless scene with a black background. The artwork URL and exact image dimensions are filled from Viscanon.'));
      const sceneFileLabel = make('label', '', 'viscanon-bridge-workspace-consent');
      const sceneFile = make('input'); sceneFile.type = 'checkbox'; sceneFile.dataset.workspaceField = 'scene-file-public';
      sceneFileLabel.append(sceneFile, make('span', 'I understand anyone with the Foundry file URL may fetch the saved artwork even while this scene is GM only.'));
      const mapButton = make('button', 'Create scene');
      mapButton.type = 'button'; mapButton.dataset.workspaceAction = 'scene';
      map.append(sceneFileLabel, mapButton);

      const actorSection = make('section', '', 'viscanon-bridge-workspace-section');
      actorSection.append(make('h3', 'Attach to actor'), make('p', 'Search an actor to set its portrait, or create a new actor using a type supported by this game system.'));
      const searchLabel = make('label', 'Search actors');
      const search = make('input'); search.type = 'search'; search.dataset.workspaceField = 'actor-search';
      search.autocomplete = 'off'; searchLabel.append(search);
      const actorLabel = make('label', 'Actor');
      const actor = make('select'); actor.dataset.workspaceField = 'actor';
      actorLabel.append(actor);
      const actorTypeLabel = make('label', 'New actor type');
      const actorType = make('select'); actorType.dataset.workspaceField = 'actor-type';
      for (const type of actions.actorTypes()) actorType.append(option(type, type));
      actorTypeLabel.append(actorType);
      const actorButton = make('button', 'Attach artwork');
      actorButton.type = 'button'; actorButton.dataset.workspaceAction = 'actor';
      const allowLabel = make('label', '', 'viscanon-bridge-workspace-consent');
      const allow = make('input'); allow.type = 'checkbox'; allow.dataset.workspaceField = 'actor-visible';
      allowLabel.append(allow, make('span', 'Visible to players now if this actor is player-visible'));
      const actorFileLabel = make('label', '', 'viscanon-bridge-workspace-consent');
      const actorFile = make('input'); actorFile.type = 'checkbox'; actorFile.dataset.workspaceField = 'actor-file-public';
      actorFileLabel.append(actorFile, make('span', 'I understand anyone with the Foundry file URL may fetch the saved portrait even while this actor is GM only.'));
      actorSection.append(searchLabel, actorLabel, actorTypeLabel, allowLabel, actorFileLabel, actorButton);
      body.append(reveal, pin, map, actorSection);
      content.append(header, body);
      return content;
    }

    _replaceHTML(result, content) {
      if (!isAuthorized()) return content.replaceChildren();
      content.replaceChildren(result);
    }

    _onRender(context, options) {
      super._onRender(context, options);
      if (!isAuthorized()) {
        if (this.element) this.element.hidden = true;
        void this.close();
        return;
      }
      const root = this.element;
      const feedback = root.querySelector('.viscanon-bridge-workspace-feedback');
      feedback.textContent = 'Loading artwork in this GM browser…';
      const transfers = [actions.prefetchArtwork(command)];
      if (entry.battlemap && entry.battlemap !== entry.image) {
        transfers.push(actions.prefetchArtwork(command, 'battlemap'));
      }
      void Promise.allSettled(transfers).then(results => {
        if (this._selectionStarted || !this.element?.isConnected || !isAuthorized()) return;
        const failure = results.find(result => result.status === 'rejected');
        feedback.textContent = failure
          ? `Artwork could not be loaded: ${failure.reason?.message || 'Transfer failed.'} Try an action while its link remains valid.`
          : 'Artwork loaded privately. Choose an action to save it in Foundry.';
      });
      const search = root.querySelector('[data-workspace-field="actor-search"]');
      const actor = root.querySelector('[data-workspace-field="actor"]');
      const actorType = root.querySelector('[data-workspace-field="actor-type"]');
      const actorTypeLabel = actorType.closest('label');
      const refreshActors = () => {
        const selected = actor.value;
        const query = search.value.trim().toLocaleLowerCase();
        actor.replaceChildren(option('', 'Create a new actor'));
        for (const item of game.actors?.contents ?? []) {
          if (!query || item.name.toLocaleLowerCase().includes(query)) actor.append(option(item.id, item.name));
        }
        if ([...actor.options].some(item => item.value === selected)) actor.value = selected;
        actorTypeLabel.hidden = Boolean(actor.value);
      };
      search.addEventListener('input', refreshActors);
      actor.addEventListener('change', () => { actorTypeLabel.hidden = Boolean(actor.value); });
      refreshActors();
      for (const button of root.querySelectorAll('[data-workspace-action]')) {
        button.addEventListener('click', async () => {
          this._selectionStarted = true;
          const controls = root.querySelectorAll('[data-workspace-action]');
          controls.forEach(control => { control.disabled = true; });
          feedback.textContent = 'Working in Foundry…';
          try {
            if (!isAuthorized()) throw new Error('This GM workspace request is no longer authorized for this account.');
            // The initial expiry only bounds delivery to this popup. A GM may
            // decide later, so recheck the command and current artwork now.
            const current = await checkAction(command);
            if (!isAuthorized() || current?.id !== command.id
              || current.campaignId !== command.campaignId
              || current.entry?.id !== command.entry.id
              || current.entry.type !== command.entry.type
              || current.entry.artworkFingerprint !== command.entry.artworkFingerprint
              || current.entry.battlemapFingerprint !== command.entry.battlemapFingerprint) {
              throw new Error('This Send to Foundry request changed. Open it again from Viscanon.');
            }
            actions.assertFresh(current);
            let name;
            switch (button.dataset.workspaceAction) {
              case 'reveal':
                await actions.revealArtwork(current);
                name = 'Artwork shared with connected players.';
                break;
              case 'pin': {
                await this.minimize();
                let placed;
                try {
                  placed = await actions.placePin(current,
                    root.querySelector('[data-workspace-field="scene"]').value,
                    root.querySelector('[data-workspace-field="visibility"]').value);
                } finally { await this.maximize(); }
                name = placed.folderStatus === 'nested' ? 'Map pin placed in its neutral chapter and category folders.'
                  : placed.folderStatus === 'private' ? 'Map pin placed in the Viscanon root. Private folder nesting awaits player-world verification.'
                    : 'Map pin placed in the Viscanon root. Stable chapter/category identity was unavailable.';
                break;
              }
              case 'scene': {
                const created = await actions.createScene(current,
                  root.querySelector('[data-workspace-field="scene-file-public"]').checked);
                name = `Scene created in the Viscanon root: ${created.name}. Private folder nesting awaits player-world verification.`;
                break;
              }
              case 'actor': {
                const attached = await actions.attachActor(current, actor.value, actorType.value,
                  root.querySelector('[data-workspace-field="actor-visible"]').checked,
                  root.querySelector('[data-workspace-field="actor-file-public"]').checked);
                name = actor.value ? `Artwork attached to ${attached.name}.`
                  : `Actor created in the Viscanon root: ${attached.name}. Private folder nesting awaits player-world verification.`;
                break;
              }
              default: throw new Error('Unsupported Foundry action.');
            }
            feedback.textContent = name;
            ui.notifications.info(name);
          } catch (error) {
            const message = error?.message || 'Foundry could not complete this action.';
            feedback.textContent = message;
            ui.notifications.error(message);
          } finally {
            root.querySelector('[data-workspace-field="scene-file-public"]').checked = false;
            root.querySelector('[data-workspace-field="actor-file-public"]').checked = false;
            root.querySelector('[data-workspace-field="actor-visible"]').checked = false;
            controls.forEach(control => { control.disabled = false; });
          }
        });
      }
    }

    _onClose(options) {
      onClose();
      actions.releaseArtwork(command);
      return super._onClose(options);
    }
  };
}
