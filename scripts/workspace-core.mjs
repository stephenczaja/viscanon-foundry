import { validateSceneOrganization } from './workspace-scene-folders.mjs';
import { BridgeHttpError, DEFAULT_ENDPOINT, TOKEN_PATTERN, normalizeCode, safeArtworkUrl } from './bridge-core.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const ENTRY_CATEGORIES = new Set(['character', 'location', 'scene']);
const CONTROL = /[\u0000-\u001f\u007f]/g;

function label(value, limit = 120) {
  return typeof value === 'string' ? value.replace(CONTROL, '').trim().slice(0, limit) : '';
}

/** Workspace payloads are GM-only, but still treated as untrusted network input. */
export function validateWorkspaceCommand(command, endpoint = DEFAULT_ENDPOINT, now = Date.now()) {
  if (!command || !UUID.test(command.id ?? '') || !UUID.test(command.campaignId ?? '')
    || command.intent !== undefined && command.intent !== 'token'
    || command.action !== 'open' || typeof command.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(command.expiresAt))
    || Date.parse(command.expiresAt) <= now) return null;
  const entry = command.entry;
  if (!entry || !UUID.test(entry.id ?? '') || typeof entry.revealed !== 'boolean'
    || entry.chapterId != null && !UUID.test(entry.chapterId)
    || !FINGERPRINT.test(entry.artworkFingerprint ?? '')
    || entry.battlemapFingerprint != null && !FINGERPRINT.test(entry.battlemapFingerprint)) return null;
  const image = safeArtworkUrl(entry.image, endpoint);
  const battlemap = entry.battlemap ? safeArtworkUrl(entry.battlemap, endpoint) : null;
  if (command.intent === 'token' && (entry.battlemap || entry.battlemapFingerprint != null)) return null;
  if (!image || (entry.battlemap && !battlemap)
    || Boolean(battlemap) !== Boolean(entry.battlemapFingerprint)) return null;
  const title = label(entry.title, 240);
  if (!title) return null;
  const type = label(entry.type, 64);
  const category = label(entry.category, 64);
  if (!ENTRY_CATEGORIES.has(type) || category !== type) return null;
  const sceneOrganization = entry.sceneOrganization === undefined ? undefined : validateSceneOrganization(entry.sceneOrganization);
  if (entry.sceneOrganization !== undefined && (!sceneOrganization
    || type === 'location' && sceneOrganization.status === 'resolved' && sceneOrganization.locations.at(-1).id !== entry.id.toLowerCase())) return null;
  return {
    id: command.id,
    action: 'open',
    ...(command.intent === 'token' ? {intent:'token'} : {}),
    campaignId: command.campaignId,
    expiresAt: Date.parse(command.expiresAt),
    entry: {
      id: entry.id,
      artworkFingerprint: entry.artworkFingerprint,
      battlemapFingerprint: entry.battlemapFingerprint || null,
      title,
      entryName: label(entry.entryName, 240) || title,
      sceneNumber: type === 'scene' ? label(entry.sceneNumber, 80) : '',
      publicTitle: label(entry.publicTitle, 240),
      type,
      chapter: label(entry.chapter),
      breadcrumbs: Array.isArray(entry.breadcrumbs) ? entry.breadcrumbs.slice(0, 16).map(value => label(value, 240)).filter(Boolean) : [],
      chapterId: entry.chapterId || null,
      category,
      ...(sceneOrganization ? {sceneOrganization} : {}),
      image,
      battlemap,
      revealed: entry.revealed
    }
  };
}

/** Polls only from the active GM with both the world read code and a private client code. */
export class WorkspaceController {
  constructor({ getConfig, isCoordinator, openCommand, onStatus = () => {},
    getPins = () => [], reconcilePins = async () => {},
    fetchImpl = globalThis.fetch.bind(globalThis), endpoint = DEFAULT_ENDPOINT,
    setTimer = globalThis.setTimeout.bind(globalThis), clearTimer = globalThis.clearTimeout.bind(globalThis),
    isOnline = () => globalThis.navigator?.onLine !== false,
    randomUUID = () => globalThis.crypto.randomUUID(),
    randomReceiveNonce = () => globalThis.crypto.randomUUID() }) {
    Object.assign(this, { getConfig, isCoordinator, openCommand, onStatus, getPins, reconcilePins,
      fetchImpl, endpoint, setTimer, clearTimer, isOnline, randomUUID, randomReceiveNonce });
    this.status = { state: 'disconnected', message: 'Pair this GM browser to receive Send to Foundry requests.' };
    this.readCode = '';
    this.gmCode = '';
    this.coordinator = false;
    this.generation = 0;
    this.timer = null;
    this.requestControllers = new Set();
    this.running = false;
    this.initialized = false;
    this.campaignId = '';
    this.session = this.randomUUID();
    this.delivered = new Map();
  }

  setStatus(state, message) {
    this.status = { state, message };
    this.onStatus(this.status);
  }

  stop() {
    ++this.generation;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    for (const controller of this.requestControllers) controller.abort();
    this.requestControllers.clear();
  }

  rotateSession() {
    this.initialized = false;
    this.campaignId = '';
    this.session = this.randomUUID();
    this.delivered.clear();
  }

  configure({ force = false } = {}) {
    const { token, gmToken } = this.getConfig();
    const readCode = normalizeCode(token);
    const gmCode = normalizeCode(gmToken);
    const coordinator = Boolean(this.isCoordinator());
    if (!force && readCode === this.readCode && gmCode === this.gmCode && coordinator === this.coordinator) return;
    this.stop();
    this.rotateSession();
    Object.assign(this, { readCode, gmCode, coordinator });
    if (!TOKEN_PATTERN.test(readCode)) return this.setStatus('disconnected', 'Connect the campaign first.');
    if (!gmCode) return this.setStatus('disconnected', 'Pair this GM browser to receive Send to Foundry requests.');
    if (!TOKEN_PATTERN.test(gmCode)) return this.setStatus('invalid', 'The private GM credential is invalid. Pair this browser again.');
    if (!coordinator) return this.setStatus('listening', 'The active GM receives Send to Foundry requests.');
    this.setStatus('connecting', 'Checking Send to Foundry…');
    this.schedule(0);
  }

  schedule(delay) {
    if (this.timer !== null) this.clearTimer(this.timer);
    const epoch = this.generation;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (epoch === this.generation) void this.tick();
    }, delay);
  }

  wake() {
    if (!this.isOnline() && (this.running || this.initialized)) {
      this.stop();
      this.rotateSession();
      this.setStatus('offline', 'Foundry is offline. Send to Foundry is unavailable.');
    }
    if (this.coordinator && TOKEN_PATTERN.test(this.readCode) && TOKEN_PATTERN.test(this.gmCode)) this.schedule(0);
  }

  async request(body, readCode = this.readCode, gmCode = this.gmCode, epoch = this.generation) {
    const controller = new AbortController();
    this.requestControllers.add(controller);
    const timeout = this.setTimer(() => controller.abort(), 15000);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Viscanon-Token': readCode,
          'X-Viscanon-GM-Token': gmCode },
        body: JSON.stringify(body), signal: controller.signal
      });
      if (epoch !== this.generation || readCode !== this.readCode || gmCode !== this.gmCode) {
        throw new DOMException('Connection changed', 'AbortError');
      }
      if (!response.ok) throw new BridgeHttpError(response.status);
      const data = await response.json();
      if (epoch !== this.generation || readCode !== this.readCode || gmCode !== this.gmCode) {
        throw new DOMException('Connection changed', 'AbortError');
      }
      return data;
    } finally {
      this.clearTimer(timeout);
      this.requestControllers.delete(controller);
    }
  }

  async testCode(code, candidateReadCode = this.getConfig().token) {
    const gmCode = normalizeCode(code);
    const readCode = normalizeCode(candidateReadCode);
    if (!TOKEN_PATTERN.test(readCode)) throw new Error('Connect a Viscanon campaign first.');
    if (!TOKEN_PATTERN.test(gmCode)) throw new Error('The private GM credential is invalid. Pair this browser again.');
    // A candidate code is intentionally not stored until its campaign binding succeeds.
    const controller = new AbortController();
    const timeout = this.setTimer(() => controller.abort(), 15000);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Viscanon-Token': readCode,
          'X-Viscanon-GM-Token': gmCode },
        body: JSON.stringify({ action: 'workspace-verify' }), signal: controller.signal
      });
      if (!response.ok) throw new BridgeHttpError(response.status);
      const data = await response.json();
      if (data?.connected !== true || !UUID.test(data.campaignId ?? '')) {
        throw new Error('Invalid GM workspace response.');
      }
      return gmCode;
    } finally {
      this.clearTimer(timeout);
    }
  }

  async acknowledge(id, ok, receiveNonce, error = '') {
    return this.request({ action: 'workspace-ack', session: this.session, receiveNonce, id, ok,
      ...(ok ? {} : { error: label(error, 160) || 'Could not open in Foundry.' }) });
  }

  async verifyPinVisibility({ campaignId, entryId, fingerprint }) {
    if (!UUID.test(campaignId ?? '') || !UUID.test(entryId ?? '')
      || !FINGERPRINT.test(fingerprint ?? '') || campaignId !== this.campaignId
      || !this.initialized || !this.coordinator || !this.isCoordinator() || !this.isOnline()) {
      throw new Error('Foundry cannot verify this pin’s current visibility.');
    }
    const epoch = this.generation;
    const session = this.session;
    const data = await this.request({ action: 'workspace-pin-check', session, campaignId, entryId, fingerprint });
    if (epoch !== this.generation || session !== this.session || !this.initialized
      || !this.coordinator || !this.isCoordinator() || !this.isOnline()
      || typeof data?.visible !== 'boolean') {
      throw new Error('Foundry cannot verify this pin’s current visibility.');
    }
    return data.visible;
  }

  async checkAction(command) {
    const entry = command?.entry;
    if (!UUID.test(command?.id ?? '') || !UUID.test(command?.campaignId ?? '')
      || !UUID.test(entry?.id ?? '') || !FINGERPRINT.test(entry?.artworkFingerprint ?? '')
      || entry.battlemapFingerprint != null && !FINGERPRINT.test(entry.battlemapFingerprint)
      || !ENTRY_CATEGORIES.has(entry?.type) || command.campaignId !== this.campaignId
      || !this.initialized || !this.coordinator || !this.isCoordinator() || !this.isOnline()) {
      throw new Error('This Send to Foundry request is no longer active. Send it again.');
    }
    const epoch = this.generation;
    const session = this.session;
    let data;
    try {
      data = await this.request({ action: 'workspace-action-check', session, id: command.id,
        campaignId: command.campaignId, entryId: entry.id, entryType: entry.type,
        artworkFingerprint: entry.artworkFingerprint,
        battlemapFingerprint: entry.battlemapFingerprint || null,
        ...(command.intent === 'token' ? {intent:'token'} : {}) });
    } catch (error) {
      if ([404, 409].includes(error?.status)) {
        throw new Error('This Send to Foundry request changed. Send the entry again.');
      }
      throw error;
    }
    if (epoch !== this.generation || session !== this.session || !this.initialized
      || !this.coordinator || !this.isCoordinator() || !this.isOnline()) {
      throw new Error('This Foundry connection changed. Send the entry again.');
    }
    // The 15-second command expiry is a delivery TTL, not the GM's decision
    // deadline. Fresh signed URLs get a separate bounded action window.
    const fresh = validateWorkspaceCommand({ id: command.id, action: 'open', campaignId: command.campaignId,
      expiresAt: new Date(Date.now() + 90_000).toISOString(), entry: data?.entry,
      ...(data?.intent !== undefined ? {intent:data.intent} : {}) }, this.endpoint);
    if (!fresh || fresh.intent !== command.intent || fresh.entry.id !== entry.id || fresh.entry.type !== entry.type
      || fresh.entry.artworkFingerprint !== entry.artworkFingerprint
      || fresh.entry.battlemapFingerprint !== (entry.battlemapFingerprint || null)) {
      throw new Error('This entry’s artwork or map changed. Send it to Foundry again.');
    }
    return fresh;
  }

  async fetchPinArtwork(proof) {
    if (!UUID.test(proof?.campaignId ?? '') || !UUID.test(proof?.entryId ?? '')
      || !FINGERPRINT.test(proof?.fingerprint ?? '') || proof.campaignId!==this.campaignId
      || !this.initialized || !this.coordinator || !this.isCoordinator() || !this.isOnline()) {
      throw new Error('Connect this campaign’s GM workspace before opening private pin artwork.');
    }
    const epoch=this.generation, session=this.session;
    const data=await this.request({action:'workspace-pin-artwork',session,
      campaignId:proof.campaignId,entryId:proof.entryId,fingerprint:proof.fingerprint});
    if (epoch!==this.generation || session!==this.session || !this.initialized
      || !this.coordinator || !this.isCoordinator() || !this.isOnline()) {
      throw new Error('The GM connection changed while opening this pin. Try again after reconnecting.');
    }
    const fresh=validateWorkspaceCommand({id:proof.entryId,action:'open',campaignId:proof.campaignId,
      expiresAt:new Date(Date.now()+90_000).toISOString(),entry:data?.entry},this.endpoint);
    if (!fresh || fresh.entry.id!==proof.entryId || fresh.entry.artworkFingerprint!==proof.fingerprint) {
      throw new Error('This pin’s artwork changed in Viscanon. Link it to the intended artwork again.');
    }
    return fresh;
  }

  async revealArtwork(command) {
    const current = await this.checkAction(command);
    const epoch = this.generation, session = this.session;
    const receipt = await this.request({ action: 'workspace-reveal', session, id: current.id,
      revealId: crypto.randomUUID(), campaignId: current.campaignId, entryId: current.entry.id,
      entryType: current.entry.type, artworkFingerprint: current.entry.artworkFingerprint,
      battlemapFingerprint: current.entry.battlemapFingerprint || null });
    if (epoch !== this.generation || session !== this.session || !this.isCoordinator()
      || receipt?.revealed !== true || !UUID.test(receipt.eventId ?? '')
      || receipt.campaignId !== current.campaignId || receipt.entryId !== current.entry.id) {
      throw new Error('The connection changed before the reveal was confirmed. Check Viscanon before retrying.');
    }
    return receipt;
  }

  async tick() {
    if (this.running || !this.coordinator || !TOKEN_PATTERN.test(this.readCode)
      || !TOKEN_PATTERN.test(this.gmCode) || !this.isCoordinator()) return;
    if (!this.isOnline()) {
      if (this.initialized) this.rotateSession();
      this.setStatus('offline', 'Foundry is offline. Send to Foundry is unavailable.');
      this.schedule(3000);
      return;
    }
    this.running = true;
    const epoch = this.generation;
    let delay = 3000;
    try {
      if (!this.initialized) {
        const bootstrap = await this.request({ action: 'workspace-bootstrap', session: this.session });
        if (bootstrap?.connected !== true || !UUID.test(bootstrap.campaignId ?? '')) {
          throw new Error('Invalid GM workspace response.');
        }
        this.campaignId = bootstrap.campaignId;
        this.initialized = true;
      }
      const pins = this.getPins(this.campaignId).slice(0, 20).filter(pin => UUID.test(pin?.entryId ?? '')
        && FINGERPRINT.test(pin?.fingerprint ?? '') && typeof pin.needsArtwork === 'boolean');
      // A receive nonce belongs to this one HTTP request. A later poll, even in
      // the same receiver session, cannot resume its unfinished commands.
      const receiveNonce = this.randomReceiveNonce();
      if (!UUID.test(receiveNonce ?? '')) throw new Error('Invalid Foundry receive nonce.');
      const data = await this.request({ action: 'workspace-poll', session: this.session, receiveNonce, pins, supportsToken:true });
      if (!data || data.receiveNonce !== receiveNonce || !Array.isArray(data.commands)
        || data.commands.length > 10) throw new Error('Invalid workspace response.');
      for (const raw of data.commands) {
        if (epoch !== this.generation || !this.isCoordinator()) return;
        if (!this.isOnline()) {
          this.rotateSession();
          this.setStatus('offline', 'Foundry is offline. Send to Foundry is unavailable.');
          return;
        }
        const id = raw?.id;
        if (!UUID.test(id ?? '')) continue;
        const previous = this.delivered.get(id);
        if (previous) {
          await this.acknowledge(id, previous.ok, receiveNonce, previous.error);
          continue;
        }
        const command = validateWorkspaceCommand(raw, this.endpoint);
        let outcome = { ok: false, error: 'Invalid Send to Foundry request.' };
        if (command && command.campaignId === this.campaignId) {
          try {
            await this.openCommand(command);
            outcome = { ok: true, error: '' };
          } catch (error) {
            outcome.error = label(error?.message, 160) || 'Could not open in Foundry.';
          }
        }
        this.delivered.set(id, outcome);
        await this.acknowledge(id, outcome.ok, receiveNonce, outcome.error);
      }
      while (this.delivered.size > 256) this.delivered.delete(this.delivered.keys().next().value);
      if (!Array.isArray(data.visiblePins) || data.visiblePins.length > 20
        || data.visiblePins.some(pair => !UUID.test(pair?.entryId ?? '')
          || !FINGERPRINT.test(pair?.fingerprint ?? '')
          || !pins.some(pin => pin.entryId === pair.entryId && pin.fingerprint === pair.fingerprint))) {
        throw new Error('Invalid pin visibility response.');
      }
      const pairKey = pair => `${pair.entryId}:${pair.fingerprint}`;
      const approved = new Set(data.visiblePins.map(pairKey));
      if (approved.size !== data.visiblePins.length
        || !Array.isArray(data.visiblePinArtwork) || data.visiblePinArtwork.length > 20
        || !Array.isArray(data.visiblePinFolders) || data.visiblePinFolders.length !== approved.size) {
        throw new Error('Invalid pin visibility response.');
      }
      const folderPairs = new Set();
      for (const item of data.visiblePinFolders) {
        if (!UUID.test(item?.entryId ?? '') || !FINGERPRINT.test(item?.fingerprint ?? '')
          || !approved.has(pairKey(item)) || folderPairs.has(pairKey(item))
          || (item.chapterId !== null && !UUID.test(item.chapterId ?? ''))
          || !ENTRY_CATEGORIES.has(item.category)) throw new Error('Invalid pin folder response.');
        folderPairs.add(pairKey(item));
      }
      const artworkPairs = new Set();
      const visiblePinArtwork = [];
      for (const item of data.visiblePinArtwork) {
        const image = safeArtworkUrl(item?.image, this.endpoint);
        const key = pairKey(item ?? {});
        if (!UUID.test(item?.entryId ?? '') || !FINGERPRINT.test(item?.fingerprint ?? '')
          || !approved.has(key) || artworkPairs.has(key) || !image
          || !pins.some(pin => pairKey(pin) === key && pin.needsArtwork)) {
          throw new Error('Invalid pin artwork response.');
        }
        artworkPairs.add(key);
        visiblePinArtwork.push({entryId: item.entryId, fingerprint: item.fingerprint, image});
      }
      if (pins.some(pin => approved.has(pairKey(pin)) && pin.needsArtwork && !artworkPairs.has(pairKey(pin)))) {
        throw new Error('Fresh artwork for a visible pin is missing.');
      }
      if (epoch !== this.generation || !this.isCoordinator()) return;
      if (!this.isOnline()) {
        this.rotateSession();
        this.setStatus('offline', 'Foundry is offline. Send to Foundry is unavailable.');
        return;
      }
      await this.reconcilePins({ campaignId: this.campaignId, requested: pins,
        visiblePins: data.visiblePins, visiblePinArtwork, visiblePinFolders: data.visiblePinFolders });
      if (epoch !== this.generation) return;
      this.setStatus('connected', 'Send to Foundry is ready on this GM browser.');
      // The held request is already the poll interval. Arm the next one
      // immediately so a Send never relies on an old heartbeat as readiness.
      delay = 0;
    } catch (error) {
      if (epoch !== this.generation) return;
      if ([401, 403].includes(error?.status)) {
        this.setStatus('invalid', 'Send to Foundry authorization was revoked or does not match this campaign.');
        delay = null;
      } else if (error?.status === 409) {
        this.setStatus('listening', 'Another GM browser is receiving requests. Check connection to take over.');
        delay = null;
      } else {
        // A recoverable online retry must not invalidate already acknowledged
        // popups. Each poll's fresh receive nonce fences unfinished delivery;
        // offline, account, credential and coordinator changes still rotate
        // the receiver session through their explicit paths.
        this.setStatus('retrying', 'GM workspace connection interrupted. Retrying…');
      }
    } finally {
      this.running = false;
      if (epoch === this.generation) {
        if (delay !== null && this.coordinator) this.schedule(delay);
      } else if (this.timer === null && this.coordinator
        && TOKEN_PATTERN.test(this.readCode) && TOKEN_PATTERN.test(this.gmCode)) {
        // A code rotation can schedule its new tick while this old request is
        // still unwinding. Resume it once the overlapping guard is released.
        this.schedule(0);
      }
    }
  }
}
