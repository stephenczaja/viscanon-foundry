import { MODULE_ID } from './bridge-core.mjs';

export function isWorkspaceNote(note) {
  return note?.document?.flags?.[MODULE_ID]?.mapPin === true
    || Boolean(note?.entry?.flags?.[MODULE_ID]?.visibility);
}

// Foundry's square ControlIcon otherwise stretches a wide SVG and draws a box.
// The SVG has transparent square padding; only our own note decorations change.
export function styleWorkspaceNote(note) {
  if (!isWorkspaceNote(note)) return;
  if (note.controlIcon?.bg) note.controlIcon.bg.visible = false;
  if (note.controlIcon?.border) note.controlIcon.border.visible = false;
}

export function createPinPlacement({ board, assertGM, icon, document: doc = globalThis.document,
  hooks = globalThis.Hooks } = {}) {
  let cancel;
  function cancelPinPlacement() { cancel?.(); }
  function captureMapPoint(scene) {
    assertGM();
    if (!scene || board?.scene?.id !== scene.id) throw new Error('Open a map in Foundry before placing a pin.');
    const view = board?.app?.view ?? board?.app?.renderer?.view;
    if (!view?.addEventListener || !board.stage?.toLocal) throw new Error('Foundry map placement is unavailable.');
    cancelPinPlacement();
    return new Promise((resolve, reject) => {
      const preview = doc.createElement?.('img');
      if (preview) {
        preview.src = icon;
        preview.className = 'viscanon-bridge-pin-preview';
        preview.alt = '';
        preview.hidden = true;
        doc.body?.append(preview);
      }
      const oldCursor = view.style?.cursor;
      if (view.style) view.style.cursor = 'crosshair';
      const hookIds = [];
      const finish = (value, error) => {
        view.removeEventListener('pointerdown', click, true);
        view.removeEventListener('pointermove', move, true);
        view.removeEventListener('pointerleave', leave, true);
        view.removeEventListener('contextmenu', context, true);
        doc.removeEventListener('keydown', escape, true);
        for (const [event, id] of hookIds) hooks.off(event, id);
        preview?.remove();
        if (view.style) view.style.cursor = oldCursor;
        cancel = undefined;
        error ? reject(error) : resolve(value);
      };
      cancel = () => finish(null);
      const escape = event => {
        if (event.key !== 'Escape') return;
        event.preventDefault?.(); event.stopImmediatePropagation?.(); cancelPinPlacement();
      };
      const context = event => { event.preventDefault(); event.stopImmediatePropagation(); cancelPinPlacement(); };
      const leave = () => { if (preview) preview.hidden = true; };
      const move = event => {
        try { assertGM(); } catch (error) { finish(null, error); return; }
        if (board.scene?.id !== scene.id) { cancelPinPlacement(); return; }
        if (preview) {
          preview.hidden = false;
          preview.style.left = `${event.clientX}px`;
          preview.style.top = `${event.clientY}px`;
        }
      };
      const click = event => {
        event.preventDefault(); event.stopImmediatePropagation();
        if (event.button === 2) { cancelPinPlacement(); return; }
        if (event.button != null && event.button !== 0) return;
        try {
          assertGM();
          if (board.scene?.id !== scene.id) { cancelPinPlacement(); return; }
          const rect = view.getBoundingClientRect();
          const renderer = board.app.renderer;
          const point = board.stage.toLocal({
            x: (event.clientX - rect.left) * renderer.width / rect.width,
            y: (event.clientY - rect.top) * renderer.height / rect.height
          });
          const bounds = board.dimensions?.sceneRect ?? { x: 0, y: 0, width: scene.width, height: scene.height };
          if (!Number.isFinite(point.x) || !Number.isFinite(point.y)
            || point.x < bounds.x || point.y < bounds.y
            || point.x > bounds.x + bounds.width || point.y > bounds.y + bounds.height) {
            globalThis.ui?.notifications?.warn?.('Choose a point inside the scene.');
            return;
          }
          finish({ x: Math.round(point.x), y: Math.round(point.y) });
        } catch (error) { finish(null, error); }
      };
      view.addEventListener('pointerdown', click, true);
      view.addEventListener('pointermove', move, true);
      view.addEventListener('pointerleave', leave, true);
      view.addEventListener('contextmenu', context, true);
      doc.addEventListener('keydown', escape, true);
      if (hooks?.on) {
        for (const event of ['canvasTearDown', 'canvasReady']) hookIds.push([event, hooks.on(event, cancelPinPlacement)]);
        for (const event of ['updateUser', 'userConnected']) hookIds.push([event, hooks.on(event, () => {
          try { assertGM(); } catch { cancelPinPlacement(); }
        })]);
      }
    });
  }
  return { captureMapPoint, cancelPinPlacement };
}
