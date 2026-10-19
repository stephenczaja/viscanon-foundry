import { MODULE_ID } from './bridge-core.mjs';

const installed = new WeakSet();
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';

// Only new, explicitly marked module documents participate. Never infer the
// identity of an old scene from its name, folder, or artwork path.
export function numberedNameFlag(entry) {
  const number = entry.type === 'scene' ? clean(entry.sceneNumber) : '';
  return number ? { numberedName: { version: 1, prefix: `${number}: ` } } : {};
}

export function playerDocumentName(document) {
  const marker = document.flags?.[MODULE_ID]?.numberedName
    ?? document.parent?.flags?.[MODULE_ID]?.numberedName;
  if (marker?.version !== 1 || typeof marker.prefix !== 'string' || !marker.prefix) return null;
  // Preserve a GM's custom native player-facing navigation name.
  const navigationName = clean(document.navName);
  if (navigationName) return navigationName;
  const name = document.name;
  return typeof name === 'string' && name.startsWith(marker.prefix)
    ? name.slice(marker.prefix.length) || 'Viscanon scene' : null;
}

export function installPlayerDocumentNames(config = globalThis.CONFIG, world = globalThis.game) {
  // Derived data is local and never updates _source or ownership. Project the
  // document name itself so directories, automatic links, sheet titles and
  // page labels use the same player name, in addition to native navName.
  for (const type of ['Scene', 'JournalEntry', 'JournalEntryPage']) {
    const Base = config?.[type]?.documentClass;
    if (typeof Base !== 'function' || installed.has(Base)) continue;
    class ViscanonNamedDocument extends Base {
      prepareDerivedData() {
        super.prepareDerivedData();
        if (world.user?.isGM) return;
        const name = playerDocumentName(this);
        if (name !== null) this.name = name;
      }
    }
    installed.add(ViscanonNamedDocument);
    config[type].documentClass = ViscanonNamedDocument;
  }
}
