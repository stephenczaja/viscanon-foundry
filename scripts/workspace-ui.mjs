import { MODULE_ID } from './bridge-core.mjs';
import { PIN_VISIBILITY, PIN_ICONS } from './workspace-actions.mjs';

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
      window: { title: 'Viscanon', resizable: true },
      position: { width: 1120, height: 630 }
    };

    async _renderHTML() {
      if (!isAuthorized()) throw new Error('This GM workspace request is no longer authorized for this account.');
      const content = make('div', '', 'viscanon-bridge-workspace-content');
      const header = make('div', '', 'viscanon-bridge-workspace-header');
      const logo = make('img');
      logo.src = `modules/${MODULE_ID}/assets/viscanon-mark-white.svg`;
      logo.alt = 'Viscanon';
      const heading = make('div', '', 'viscanon-bridge-workspace-heading');
      heading.append(make('h2', entry.title));
      // Only show real ancestry supplied by Viscanon; category is an internal
      // discriminator, not a breadcrumb. Older servers provide the chapter.
      const ancestors = entry.breadcrumbs?.length ? entry.breadcrumbs : [entry.chapter].filter(Boolean);
      heading.append(make('p', ancestors.join(' › '), 'viscanon-bridge-workspace-meta'));
      header.append(logo, heading);
      const body = make('div', '', 'viscanon-bridge-workspace-body');
      const artwork = make('aside', '', 'viscanon-bridge-workspace-art');
      const preview = make('img', '', 'viscanon-bridge-workspace-preview');
      preview.src = entry.image;
      preview.alt = `GM preview of ${entry.title}`;
      artwork.append(preview);
      const feedback = make('p', 'Choose an action.', 'viscanon-bridge-workspace-feedback');
      feedback.setAttribute('role', 'status');
      feedback.setAttribute('aria-live', 'polite');
      const choices = make('div', '', 'viscanon-bridge-workspace-choices');

      const reveal = make('section', '', 'viscanon-bridge-workspace-section');
      reveal.append(make('h3', 'Reveal artwork'), make('p', 'Show this artwork to everyone connected to Foundry and reveal in Viscanon.'));
      const revealButton = make('button', 'Reveal artwork to players');
      revealButton.type = 'button'; revealButton.dataset.workspaceAction = 'reveal';
      reveal.append(revealButton);

      const pin = make('section', '', 'viscanon-bridge-workspace-section');
      pin.append(make('h3', 'Place map pin'), make('p', 'Place the Viscanon eye on the map you are viewing. Click to place; Escape to cancel.'));
      const visibilityLabel = make('label', 'Pin visibility', 'viscanon-bridge-workspace-visibility');
      const visibility = make('select'); visibility.dataset.workspaceField = 'visibility';
      visibility.append(
        option(PIN_VISIBILITY.onReveal, 'Will appear on reveal'),
        option(PIN_VISIBILITY.gmOnly, 'GM only'),
        option(PIN_VISIBILITY.visible, 'Visible to players')
      );
      visibility.value = PIN_VISIBILITY.onReveal;
      const visibilityArtwork = make('img', '', 'viscanon-bridge-workspace-visibility-icon');
      visibilityArtwork.src = PIN_ICONS[PIN_VISIBILITY.onReveal];
      visibilityArtwork.alt = 'Will appear on reveal';
      visibilityLabel.append(visibilityArtwork, visibility);
      const pinButton = make('button', 'Place map pin');
      pinButton.type = 'button'; pinButton.dataset.workspaceAction = 'pin';
      const pinButtons=make('div','','viscanon-bridge-workspace-pin-buttons');
      pinButtons.append(pinButton);
      pin.append(visibilityLabel,pinButtons);

      const map = make('section', '', 'viscanon-bridge-workspace-section');
      map.append(make('h3', 'Create scene'), make('p', 'Create a gridless scene in Foundry featuring this artwork.'));
      const mapButton = make('button', 'Create scene');
      mapButton.type = 'button'; mapButton.dataset.workspaceAction = 'scene';
      map.append(mapButton);

      const actorSection = make('section', '', 'viscanon-bridge-workspace-section');
      actorSection.append(make('h3', 'Attach to actor'), make('p', 'Set an actor’s portrait or create a new actor.'));
      const actorLabel = make('label', 'Actor');
      const actor = make('select'); actor.dataset.workspaceField = 'actor';
      actorLabel.append(actor);
      const actorTypeLabel = make('label', 'New actor type');
      const actorType = make('select'); actorType.dataset.workspaceField = 'actor-type';
      for (const type of actions.actorTypes()) actorType.append(option(type, type));
      actorTypeLabel.append(actorType);
      const actorButton = make('button', 'Attach artwork');
      actorButton.type = 'button'; actorButton.dataset.workspaceAction = 'actor';
      const actorFields = make('div', '', 'viscanon-bridge-workspace-actor-fields');
      actorFields.append(actorLabel, actorTypeLabel);
      actorSection.append(actorFields, actorButton);
      choices.append(reveal, pin, map, actorSection);
      body.append(artwork, choices);
      content.append(header, body, feedback);
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
      feedback.textContent = 'Loading artwork…';
      const transfers = [actions.prefetchArtwork(command)];
      if (entry.battlemap && entry.battlemap !== entry.image) {
        transfers.push(actions.prefetchArtwork(command, 'battlemap'));
      }
      void Promise.allSettled(transfers).then(results => {
        if (this._selectionStarted || !this.element?.isConnected || !isAuthorized()) return;
        const failure = results.find(result => result.status === 'rejected');
        feedback.textContent = failure
          ? `Artwork could not be loaded: ${failure.reason?.message || 'Transfer failed.'} Try an action while its link remains valid.`
          : 'Ready.';
      });
      const visibility = root.querySelector('[data-workspace-field="visibility"]');
      const visibilityArtwork = root.querySelector('.viscanon-bridge-workspace-visibility-icon');
      visibility.addEventListener('change', () => {
        visibilityArtwork.src = PIN_ICONS[visibility.value];
        visibilityArtwork.alt = visibility.selectedOptions[0].textContent;
      });
      const actor = root.querySelector('[data-workspace-field="actor"]');
      const actorType = root.querySelector('[data-workspace-field="actor-type"]');
      const actorTypeLabel = actorType.closest('label');
      const refreshActors = () => {
        const selected = actor.value;
        actor.replaceChildren(option('', 'Create a new actor'));
        for (const item of game.actors?.contents ?? []) {
          actor.append(option(item.id, item.name));
        }
        if ([...actor.options].some(item => item.value === selected)) actor.value = selected;
        actorTypeLabel.hidden = Boolean(actor.value);
      };
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
                name = 'Artwork shared with connected players and revealed in Viscanon.';
                break;
              case 'pin': {
                this._placingPin = true;
                await this.minimize();
                let placed;
                try {
                  if (this._workspaceClosed) return;
                  placed = await actions.placePin(current,
                    globalThis.canvas?.scene?.id,
                    root.querySelector('[data-workspace-field="visibility"]').value);
                } finally {
                  this._placingPin = false;
                  if (!this._workspaceClosed) await this.maximize();
                }
                name = placed ? 'Map pin placed.' : 'Map pin placement cancelled.';
                break;
              }
              case 'scene': {
                await actions.createScene(current, true);
                name = 'Scene created.';
                break;
              }
              case 'actor': {
                const attached = await actions.attachActor(current, actor.value, actorType.value,
                  false, true);
                name = actor.value ? `Artwork attached to ${attached.name}.` : 'Actor created.';
                break;
              }
              default: throw new Error('Unsupported Foundry action.');
            }
            if (this._workspaceClosed) return;
            feedback.textContent = name;
            ui.notifications.info(name);
          } catch (error) {
            const message = error?.message || 'Foundry could not complete this action.';
            feedback.textContent = message;
            ui.notifications.error(message);
          } finally {
            controls.forEach(control => { control.disabled = false; });
          }
        });
      }
    }

    _onClose(options) {
      this._workspaceClosed = true;
      if (this._placingPin) actions.cancelPinPlacement?.();
      onClose();
      actions.releaseArtwork(command);
      return super._onClose(options);
    }
  };
}
