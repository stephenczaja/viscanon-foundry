export const MODULE_ID = 'viscanon-bridge';
export const SOCKET_NAME = `module.${MODULE_ID}`;
export const DEFAULT_ENDPOINT = 'https://xzievefbzeyvefazppvj.supabase.co/functions/v1/foundry-bridge';
export const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CURSOR_PATTERN = /^(?:0|[1-9][0-9]{0,38})$/;
const MAX_EVENT_AGE_MS = 10 * 60 * 1000;

export function isCursor(value) {
  return typeof value === 'string' && CURSOR_PATTERN.test(value);
}

export function normalizeCode(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function safeArtworkUrl(value, endpoint = DEFAULT_ENDPOINT) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  try {
    const url = new URL(value);
    const backend = new URL(endpoint);
    if (url.protocol === 'https:' && url.origin === 'https://app.viscanon.com'
      && !url.username && !url.password && !url.search && !url.hash
      && /^\/assets\/(?:[a-zA-Z0-9][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9][a-zA-Z0-9._-]*\.(?:avif|gif|jpe?g|png|webp)$/i.test(url.pathname)
      && !value.includes('..') && !value.includes('%')) return url.href;
    // The bridge resolves managed artwork to Supabase Storage signed URLs.
    // Arbitrary remote hosts, executable URL schemes and URL credentials are refused.
    if (url.protocol !== 'https:' || url.origin !== backend.origin || url.username || url.password) return null;
    if (!url.pathname.startsWith('/storage/v1/object/sign/')) return null;
    if (!url.searchParams.get('token')) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function validateDisplayEvent(event, { endpoint = DEFAULT_ENDPOINT, now = Date.now(), id } = {}) {
  if (!event || typeof event !== 'object' || !UUID_PATTERN.test(event.id ?? '')) return null;
  if (id && event.id !== id) return null;
  if (!isCursor(event.sequence) || !['reveal', 'memory'].includes(event.type)) return null;
  if (!UUID_PATTERN.test(event.campaignId ?? '') || !event.item
    || typeof event.item.id !== 'string' || !event.item.id || event.item.id.length > 120
    || /[\u0000-\u001f\u007f]/.test(event.item.id)) return null;
  const createdAt = Date.parse(event.createdAt);
  const expiresAt = Date.parse(event.expiresAt);
  if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt)) return null;
  if (createdAt > now + 60000 || now - createdAt > MAX_EVENT_AGE_MS || expiresAt <= now) return null;
  if (expiresAt > createdAt + MAX_EVENT_AGE_MS + 1000) return null;
  const imageUrl = safeArtworkUrl(event.item.image, endpoint);
  if (!imageUrl || typeof event.item.title !== 'string') return null;
  const title = event.item.title.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240) || 'Viscanon artwork';
  return { id: event.id, sequence: event.sequence, imageUrl, title, expiresAt };
}

export class BridgeHttpError extends Error {
  constructor(status) {
    super(`Viscanon bridge request failed (${status}).`);
    this.name = 'BridgeHttpError';
    this.status = status;
  }
}

/** Foundry integration is injected so multi-client behavior can be tested without a licensed runtime. */
export class BridgeController {
  constructor({ getConfig, isCoordinator, saveCheckpoint, broadcast, display, onStatus = () => {},
    fetchImpl = globalThis.fetch, endpoint = DEFAULT_ENDPOINT, now = () => Date.now(),
    setTimer = setTimeout, clearTimer = clearTimeout, isOnline = () => globalThis.navigator?.onLine !== false }) {
    Object.assign(this, { getConfig, isCoordinator, saveCheckpoint, broadcast, display, onStatus,
      fetchImpl, endpoint, now, setTimer, clearTimer, isOnline });
    this.generation = 0;
    this.deliveryGeneration = 0;
    this.configured = false;
    this.coordinator = false;
    this.token = '';
    this.timer = null;
    this.running = false;
    this.restartPending = false;
    this.requests = new Map();
    this.seen = new Map();
    this.pending = new Map();
    this.deliveryQueue = Promise.resolve();
    this.initialized = false;
    this.cursor = '0';
    this.failures = 0;
    this.status = { state: 'disconnected', message: 'Paste a connection code from Viscanon to connect.' };
  }

  setStatus(state, message) {
    this.status = { state, message };
    this.onStatus(this.status);
  }

  configure({ force = false } = {}) {
    const code = normalizeCode(this.getConfig().token);
    const coordinator = this.isCoordinator();
    const tokenChanged = code !== this.token;
    if (this.configured && !tokenChanged && coordinator === this.coordinator && !force) return;
    this.stop({ deliveries: tokenChanged });
    this.configured = true;
    this.coordinator = coordinator;
    if (tokenChanged) {
      this.seen.clear();
      this.pending.clear();
    }
    this.token = code;
    this.initialized = false;
    this.failures = 0;
    if (!code) return this.setStatus('disconnected', 'Paste a connection code from Viscanon to connect.');
    if (!TOKEN_PATTERN.test(code)) return this.setStatus('invalid', 'The connection code must contain 64 hexadecimal characters.');
    if (!this.isCoordinator()) return this.setStatus('listening', 'Listening for Viscanon artwork. The active GM receives updates.');
    this.setStatus('connecting', 'Connecting to Viscanon…');
    this.schedule(0);
  }

  stop({ deliveries = true } = {}) {
    this.generation += 1;
    if (deliveries) this.deliveryGeneration += 1;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    for (const [request, kind] of this.requests) {
      if (deliveries || kind === 'poll') { request.abort(); this.requests.delete(request); }
    }
  }

  destroy() {
    this.stop();
    this.token = '';
    this.pending.clear();
  }

  wake() {
    if (this.token && this.isCoordinator()) this.schedule(0);
  }

  schedule(delay) {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (this.running) {
      this.restartPending = true;
      return;
    }
    const epoch = this.generation;
    this.timer = this.setTimer(() => {
      this.timer = null;
      if (epoch === this.generation) void this.tick();
    }, delay);
  }

  async request(body, epoch = this.generation, token = this.token, kind = 'poll') {
    const controller = new AbortController();
    this.requests.set(controller, kind);
    const currentEpoch = () => kind === 'delivery' ? this.deliveryGeneration : this.generation;
    // Browser fetch can otherwise wait indefinitely after a lost connection.
    const timeout = this.setTimer(() => controller.abort(), 15000);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Viscanon-Token': token },
        body: JSON.stringify(body), signal: controller.signal
      });
      if (epoch !== currentEpoch() || token !== this.token) throw new DOMException('Connection changed', 'AbortError');
      if (!response.ok) throw new BridgeHttpError(response.status);
      const data = await response.json();
      if (epoch !== currentEpoch() || token !== this.token) throw new DOMException('Connection changed', 'AbortError');
      return data;
    } finally {
      this.clearTimer(timeout);
      this.requests.delete(controller);
    }
  }

  async testCode(code) {
    const token = normalizeCode(code);
    if (!TOKEN_PATTERN.test(token)) throw new Error('Paste the full 64-character Viscanon connection code.');
    const controller = new AbortController();
    const timeout = this.setTimer(() => controller.abort(), 15000);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Viscanon-Token': token },
        body: JSON.stringify({ action: 'bootstrap' }), signal: controller.signal
      });
      if (!response.ok) throw new BridgeHttpError(response.status);
      const data = await response.json();
      if (data?.connected !== true || !isCursor(data.cursor)) throw new Error('The bridge returned an invalid connection response.');
      return { token, cursor: data.cursor };
    } finally {
      this.clearTimer(timeout);
    }
  }

  async checkpoint(cursor, epoch) {
    if (!isCursor(cursor)) throw new Error('The bridge returned an invalid cursor.');
    if (epoch !== this.generation) return;
    this.cursor = cursor;
    await this.saveCheckpoint({ token: this.token, cursor });
  }

  async pause(milliseconds, epoch) {
    if (epoch !== this.deliveryGeneration) throw new DOMException('Connection changed', 'AbortError');
    const controller = new AbortController();
    this.requests.set(controller, 'delivery');
    try {
      await new Promise((resolve, reject) => {
        const timer = this.setTimer(resolve, milliseconds);
        controller.signal.addEventListener('abort', () => {
          this.clearTimer(timer);
          reject(new DOMException('Connection changed', 'AbortError'));
        }, { once: true });
      });
    } finally {
      this.requests.delete(controller);
    }
  }

  async tick() {
    if (this.running || !TOKEN_PATTERN.test(this.token) || !this.isCoordinator()) return;
    if (!this.isOnline()) {
      this.setStatus('offline', 'Offline. Artwork will resume when the connection returns.');
      this.schedule(5000);
      return;
    }
    this.running = true;
    const epoch = this.generation;
    let delay = 3000;
    try {
      if (!this.initialized) {
        const data = await this.request({ action: 'bootstrap' }, epoch);
        if (data?.connected !== true || !isCursor(data.cursor)) throw new Error('Invalid bridge response.');
        const saved = this.getConfig().checkpoint;
        const reusable = saved?.token === this.token && isCursor(saved.cursor) && BigInt(saved.cursor) <= BigInt(data.cursor);
        await this.checkpoint(reusable ? saved.cursor : data.cursor, epoch);
        if (epoch !== this.generation) return;
        this.initialized = true;
      }
      const data = await this.request({ action: 'poll', cursor: this.cursor, limit: 25 }, epoch);
      if (!data || !Array.isArray(data.events) || data.events.length > 25 || !isCursor(data.cursor)) throw new Error('Invalid bridge response.');
      if (typeof data.hasMore !== 'boolean' || BigInt(data.cursor) < BigInt(this.cursor)) throw new Error('Invalid bridge cursor.');
      let previous = BigInt(this.cursor);
      for (const event of data.events) {
        if (epoch !== this.generation || !this.isCoordinator()) return;
        if (!UUID_PATTERN.test(event?.id ?? '') || !isCursor(event.sequence) || BigInt(event.sequence) <= previous || BigInt(event.sequence) > BigInt(data.cursor)) throw new Error('Invalid bridge event order.');
        previous = BigInt(event.sequence);
        const shown = await this.receive({ type: 'artwork', id: event.id });
        if (epoch !== this.generation || !this.isCoordinator()) return;
        if (shown) this.broadcast({ type: 'artwork', id: event.id });
        await this.checkpoint(event.sequence, epoch);
      }
      await this.checkpoint(data.cursor, epoch);
      if (epoch !== this.generation) return;
      this.failures = 0;
      this.setStatus('connected', 'Connected. New reveals and shared memories appear for everyone in this world.');
      delay = data.hasMore ? 0 : Math.min(60000, Math.max(1500, Number(data.pollAfterMs) || 3000));
    } catch (error) {
      if (epoch !== this.generation) return;
      if ([401, 403].includes(error?.status)) {
        this.setStatus('invalid', 'The connection code was revoked or is no longer available. Create a new code in Viscanon.');
        delay = null;
      } else {
        this.failures += 1;
        delay = Math.min(30000, 3000 * (2 ** Math.min(this.failures - 1, 4)));
        this.setStatus('retrying', 'Connection interrupted. Retrying automatically…');
      }
    } finally {
      this.running = false;
      if (this.restartPending) {
        this.restartPending = false;
        if (this.token && this.isCoordinator()) this.schedule(0);
      } else if (epoch === this.generation && delay !== null && this.token && this.isCoordinator()) {
        this.schedule(delay);
      }
    }
  }

  receive(packet) {
    if (!TOKEN_PATTERN.test(this.token) || packet?.type !== 'artwork' || !UUID_PATTERN.test(packet.id ?? '')) return Promise.resolve(false);
    this.pruneSeen();
    if (this.seen.has(packet.id)) return Promise.resolve(this.seen.get(packet.id).available);
    if (this.pending.has(packet.id)) return this.pending.get(packet.id);
    if (this.pending.size >= 32) return Promise.resolve(false);
    const id = packet.id;
    const epoch = this.deliveryGeneration;
    const token = this.token;
    const deadline = this.now() + MAX_EVENT_AGE_MS;
    const delivery = this.deliveryQueue.catch(() => {}).then(async () => {
      if (epoch !== this.deliveryGeneration || token !== this.token) return false;
      let failures = 0;
      while (epoch === this.deliveryGeneration && this.now() < deadline) {
        try {
          // No payload artwork or claimed sender identity is trusted. Each recipient
          // independently checks this event against the paired campaign and visibility.
          const data = await this.request({ action: 'event', id }, epoch, token, 'delivery');
          const event = validateDisplayEvent(data?.event, { id, endpoint: this.endpoint, now: this.now() });
          if (!event || epoch !== this.deliveryGeneration) return false;
          await this.display(event);
          if (epoch !== this.deliveryGeneration) return false;
          this.seen.set(id, { expiresAt: event.expiresAt, available: true });
          return true;
        } catch (error) {
          if ([404, 410].includes(error?.status)) {
            this.seen.set(id, { expiresAt: deadline, available: false });
            return false;
          }
          if (epoch !== this.deliveryGeneration) return false;
          if ([401, 403].includes(error?.status)) throw error;
          failures += 1;
          const delay = Math.min(30000, 1000 * (2 ** Math.min(failures - 1, 5)), deadline - this.now());
          if (delay <= 0) return false;
          this.setStatus('retrying', 'Artwork connection interrupted. Retrying automatically…');
          try { await this.pause(delay, epoch); } catch { return false; }
        }
      }
      return false;
    }).finally(() => {
      if (this.pending.get(id) === delivery) this.pending.delete(id);
    });
    this.pending.set(id, delivery);
    this.deliveryQueue = delivery;
    return delivery;
  }

  pruneSeen() {
    for (const [id, value] of this.seen) if (value.expiresAt <= this.now()) this.seen.delete(id);
    while (this.seen.size > 256) this.seen.delete(this.seen.keys().next().value);
  }
}
