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
  const tokenIntent = command.intent === 'token';
  return class ViscanonWorkspace extends foundry.applications.api.ApplicationV2 {
    static DEFAULT_OPTIONS = {
      classes: ['viscanon-bridge-workspace'],
      window: { title: tokenIntent ? 'Attach token to actor' : 'Viscanon', resizable: true },
      position: tokenIntent ? { width: 820, height: 500 } : { width: 1120, height: 630 }
    };

    async _renderHTML() {
      if (!isAuthorized()) throw new Error('This GM workspace request is no longer authorized for this account.');
      const content = make('div', '', `viscanon-bridge-workspace-content${tokenIntent ? ' viscanon-bridge-workspace-token' : ''}`);
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
      preview.alt = `GM ${tokenIntent ? 'token ' : ''}preview of ${entry.title}`;
      artwork.append(preview);
      const feedback = make('p', tokenIntent ? 'Choose an actor.' : 'Choose an action.', 'viscanon-bridge-workspace-feedback');
      feedback.setAttribute('role', 'status');
      feedback.setAttribute('aria-live', 'polite');
      const choices = make('div', '', 'viscanon-bridge-workspace-choices');

      if (!tokenIntent) {
        const reveal = make('section', '', 'viscanon-bridge-workspace-section');
        reveal.append(make('h3', 'Reveal artwork'), make('p', 'Show this artwork as a popup to everyone connected to Foundry and reveal in Viscanon.'));
        const revealButton = make('button', 'Reveal artwork to players');
        revealButton.type = 'button'; revealButton.dataset.workspaceAction = 'reveal';
        reveal.append(revealButton);

        const pin = make('section', '', 'viscanon-bridge-workspace-section');
        pin.append(make('h3', 'Place map pin'), make('p', 'Place a pin on the current scene. Double-click the pin to view this artwork. Click to place; Escape to cancel.'));
        const visibilityField = make('div', '', 'viscanon-bridge-workspace-visibility');
        const visibilityLabel = make('label', 'Pin visibility');
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
        visibilityLabel.append(visibility);
        visibilityField.append(visibilityArtwork, visibilityLabel);
        const pinButton = make('button', 'Place map pin');
        pinButton.type = 'button'; pinButton.dataset.workspaceAction = 'pin';
        const pinButtons=make('div','','viscanon-bridge-workspace-pin-buttons');
        pinButtons.append(pinButton);
        pin.append(visibilityField,pinButtons);

        const map = make('section', '', 'viscanon-bridge-workspace-section');
        map.append(make('h3', 'Create scene'), make('p', 'Create a gridless scene in Foundry featuring this artwork.'));
        const mapButton = make('button', 'Create scene');
        mapButton.type = 'button'; mapButton.dataset.workspaceAction = 'scene';
        map.append(mapButton);
        choices.append(reveal, pin, map);
      }

      const actorSection = make('section', '', 'viscanon-bridge-workspace-section');
      actorSection.append(make('h3', tokenIntent ? 'Attach token to actor' : 'Attach artwork to actor'));
      const actorModes = make('div', '', 'viscanon-bridge-workspace-actor-modes');
      actorModes.setAttribute('role', 'group');
      actorModes.setAttribute('aria-label', 'Actor action');
      for (const [mode, label] of [['create', 'Create new actor'], ['select', 'Select an actor']]) {
        const button = make('button', label);
        button.type = 'button'; button.dataset.workspaceField = `actor-mode-${mode}`;
        button.setAttribute('aria-pressed', String(mode === 'create'));
        actorModes.append(button);
      }
      const actorLabel = make('label', 'Actor');
      actorLabel.hidden = true;
      const actor = make('select'); actor.dataset.workspaceField = 'actor';
      actor.disabled = true;
      actorLabel.append(actor);
      const actorTypeLabel = make('label', 'New actor type');
      const actorType = make('select'); actorType.dataset.workspaceField = 'actor-type';
      for (const type of actions.actorTypes()) actorType.append(option(type, type));
      actorTypeLabel.append(actorType);
      const actorButton = make('button', tokenIntent ? 'Attach token' : 'Attach artwork');
      actorButton.type = 'button'; actorButton.dataset.workspaceAction = 'actor';
      const actorFields = make('div', '', 'viscanon-bridge-workspace-actor-fields');
      actorFields.append(actorLabel, actorTypeLabel);
      actorSection.append(actorModes, actorFields, actorButton);
      choices.append(actorSection);
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
      feedback.textContent = tokenIntent ? 'Loading token…' : 'Loading artwork…';
      const transfers = [actions.prefetchArtwork(command)];
      if (!tokenIntent && entry.battlemap && entry.battlemap !== entry.image) {
        transfers.push(actions.prefetchArtwork(command, 'battlemap'));
      }
      void Promise.allSettled(transfers).then(results => {
        if (this._selectionStarted || !this.element?.isConnected || !isAuthorized()) return;
        const failure = results.find(result => result.status === 'rejected');
        feedback.textContent = failure
          ? `${tokenIntent ? 'Token' : 'Artwork'} could not be loaded: ${failure.reason?.message || 'Transfer failed.'} Try an action while its link remains valid.`
          : 'Ready.';
      });
      const visibility = root.querySelector('[data-workspace-field="visibility"]');
      const visibilityArtwork = root.querySelector('.viscanon-bridge-workspace-visibility-icon');
      visibility?.addEventListener('change', () => {
        visibilityArtwork.src = PIN_ICONS[visibility.value];
        visibilityArtwork.alt = visibility.selectedOptions[0].textContent;
      });
      const actor = root.querySelector('[data-workspace-field="actor"]');
      const actorType = root.querySelector('[data-workspace-field="actor-type"]');
      const actorLabel = actor.closest('label');
      const actorTypeLabel = actorType.closest('label');
      const actorButton = root.querySelector('[data-workspace-action="actor"]');
      const actorCreate = root.querySelector('[data-workspace-field="actor-mode-create"]');
      const actorSelect = root.querySelector('[data-workspace-field="actor-mode-select"]');
      const actorModeButtons = [actorCreate, actorSelect];
      let actorMode = 'create';
      const syncActorMode = () => {
        const creating = actorMode === 'create';
        const actorLocked = Boolean(this._actionPending || (tokenIntent && this._attachedTokenActor));
        actorLabel.hidden = creating;
        actorTypeLabel.hidden = !creating;
        actor.disabled = creating || actorLocked;
        actorType.disabled = !creating || actorLocked;
        actorButton.disabled = actorLocked || (!creating && !actor.value);
        if (tokenIntent && this._attachedTokenActor) actorButton.textContent = 'Token attached';
        actorCreate.setAttribute('aria-pressed', String(creating));
        actorSelect.setAttribute('aria-pressed', String(!creating));
        actorModeButtons.forEach(button => { button.disabled = actorLocked; });
      };
      for (const [button, mode] of [[actorCreate, 'create'], [actorSelect, 'select']]) {
        button.addEventListener('click', () => {
          if (this._actionPending || (tokenIntent && this._attachedTokenActor) || !isAuthorized()) return;
          actorMode = mode;
          if (mode === 'select') refreshActors();
          else syncActorMode();
        });
      }
      const refreshActors = () => {
        const selected = actor.value;
        const available = [...(game.actors?.contents ?? [])].sort((left, right) =>
          String(left.name).localeCompare(String(right.name), undefined, { sensitivity: 'base', numeric: true })
          || String(left.id).localeCompare(String(right.id)));
        const placeholder = option('', available.length ? 'Choose an actor' : 'No actors available');
        placeholder.disabled = true;
        actor.replaceChildren(placeholder);
        for (const item of available) {
          actor.append(option(item.id, item.name));
        }
        if ([...actor.options].some(item => item.value === selected)) actor.value = selected;
        syncActorMode();
      };
      actor.addEventListener('change', syncActorMode);
      refreshActors();
      for (const button of root.querySelectorAll('[data-workspace-action]')) {
        button.addEventListener('click', async () => {
          if (this._actionPending || (tokenIntent && this._attachedTokenActor)) return;
          // Keep this click's actor choice stable while action validation awaits
          // the server. An in-flight attachment cannot change into creation.
          const actorChoice = { mode: actorMode, id: actor.value, type: actorType.value };
          this._actionPending = true;
          syncActorMode();
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
              || (current.intent === 'token') !== tokenIntent
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
                this._createdScene ??= await actions.createScene(current, true);
                button.textContent = 'View created scene';
                try { await actions.viewScene(this._createdScene); }
                catch (error) {
                  throw new Error(`Scene created, but its view could not be opened. Open it from Scenes or try “View created scene”. ${error?.message || ''}`);
                }
                name = 'Scene created and opened in your view.';
                break;
              }
              case 'actor': {
                if (actorChoice.mode === 'select' && !actorChoice.id) throw new Error('Choose an existing actor.');
                const actorId = actorChoice.mode === 'select' ? actorChoice.id : '';
                if (tokenIntent) {
                  this._attachedTokenActor = await actions.attachToken(current, actorId, actorChoice.type,
                    false, true);
                  name = actorId ? `Token attached to ${this._attachedTokenActor.name}.` : 'Actor created and token attached.';
                } else {
                  const attached = await actions.attachActor(current, actorId, actorChoice.type,
                    false, true);
                  name = actorId ? `Artwork attached to ${attached.name}.` : 'Actor created.';
                }
                refreshActors();
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
            this._actionPending = false;
            controls.forEach(control => { control.disabled = false; });
            syncActorMode();
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
