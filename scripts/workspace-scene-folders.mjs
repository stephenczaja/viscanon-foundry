const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const REASONS = new Set(['missing', 'ambiguous', 'cycle', 'depth', 'limit', 'invalid']);
const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 240) : '';

/** This private GM projection contains only the canonical location path. */
export function validateSceneOrganization(value) {
  if (!value || value.version !== 1 || !['resolved', 'none', 'unresolved'].includes(value.status)
    || !Array.isArray(value.locations) || value.locations.length > 12) return null;
  if (value.status === 'unresolved' ? !REASONS.has(value.reason)
    : value.reason !== '') return null;
  if (value.status === 'resolved' ? !value.locations.length : value.locations.length) return null;
  const seen = new Set(), locations = [];
  for (const row of value.locations) {
    if (!row || !UUID.test(row.id ?? '') || seen.has(row.id.toLowerCase()) || !clean(row.name)) return null;
    seen.add(row.id.toLowerCase());
    locations.push({id: row.id.toLowerCase(), name: clean(row.name)});
  }
  return {version: 1, status: value.status, reason: value.reason, locations};
}

const digest = async value => [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256',
  new TextEncoder().encode(value)))].map(byte => byte.toString(16).padStart(2, '0')).join('');

/** Keep ancestry in one label so categories fit Foundry's native four levels. */
export async function sceneFolderPlan(command, nativeDepth = 4) {
  const organization = validateSceneOrganization(command.entry.sceneOrganization);
  if (!organization || !UUID.test(command.campaignId ?? '')
    || command.entry.chapterId != null && !UUID.test(command.entry.chapterId)) throw new Error('Invalid Scene location information. Send this entry again.');
  const maximum = Number.isInteger(nativeDepth) && nativeDepth >= 1 && nativeDepth <= 32 ? nativeDepth : 4;
  const chapter = clean(command.entry.chapter), context = command.entry.chapterId || 'unassigned';
  const base = `${command.campaignId}:${context}`;
  const steps = [];
  if (chapter) steps.push({name: chapter, role: 'chapter', key: await digest(`viscanon-folder-v1:chapter:${base}`)});
  const locations = organization.locations, ancestry = locations.map(row => row.id).join(':');
  if (locations.length) {
    // A nested location is a chapter-level sibling whose label records every
    // ancestor. Identity still uses the complete canonical UUID path.
    steps.push({name: locations.map(row => row.name).join(' — '), role: 'location',
      key: await digest(`viscanon-scene-folder-v1:location:${base}:${ancestry}`)});
  }
  const category = {location: 'Locations', character: 'Characters', scene: 'Scenes'}[command.entry.type];
  if (!category) throw new Error('Unsupported entry type.');
  // A location's own artwork belongs directly in that location folder.
  if (command.entry.type !== 'location' || organization.status !== 'resolved') {
    // Unlocated entries retain the existing chapter/category identity, so an
    // upgrade reuses the GM's folder instead of creating a duplicate beside it.
    const identity = locations.length ? `viscanon-scene-folder-v1:category:${base}:${ancestry}:${command.entry.type}`
      : `viscanon-folder-v1:category:${base}:${command.entry.type}`;
    steps.push({name: category, role: 'category', key: await digest(identity)});
  }
  // The Viscanon root is level one. Never override Foundry's native limit or
  // silently discard the requested location/category organization.
  if (steps.length + 1 > maximum) throw new Error('Foundry’s folder depth limit cannot support this Scene folder layout.');
  return {steps, notice: organization.status === 'unresolved'
    ? 'Viscanon could not resolve this entry’s location; the Scene uses the chapter’s category folder.' : ''};
}

export function sceneOrganizationIdentity(entry) {
  return JSON.stringify([entry.chapterId || null, entry.chapter || '', entry.sceneOrganization || null]);
}
