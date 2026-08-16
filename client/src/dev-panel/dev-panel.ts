import type { Room } from 'colyseus.js';
import { DEFAULTS_REGISTRY } from '@rocket-arena/shared';

let panelEl: HTMLElement | null = null;
let visible = false;

export function createDevPanel(room: Room): void {
  if (import.meta.env.PROD) return; // Only in dev mode

  panelEl = document.createElement('div');
  panelEl.id = 'dev-panel';
  panelEl.innerHTML = '<h3>Dev Panel</h3><div id="dev-panel-content"></div><button id="dev-reset-btn">Reset All</button>';

  const style = document.createElement('style');
  style.textContent = `
    #dev-panel { position: fixed; top: 0; right: 0; width: 300px; max-height: 100vh; overflow-y: auto; background: rgba(0,0,0,0.9); color: #eee; font-family: monospace; font-size: 11px; padding: 8px; z-index: 100; display: none; }
    #dev-panel h3 { margin: 0 0 8px; color: #0f0; }
    #dev-panel .group { margin-bottom: 8px; }
    #dev-panel .group-title { font-weight: bold; color: #ff0; cursor: pointer; }
    #dev-panel .group-content { padding-left: 8px; }
    #dev-panel .row { display: flex; justify-content: space-between; align-items: center; margin: 2px 0; }
    #dev-panel .row label { flex: 1; }
    #dev-panel .row input { width: 70px; background: #222; color: #fff; border: 1px solid #444; padding: 2px 4px; }
    #dev-panel button { margin-top: 8px; padding: 4px 8px; background: #c00; color: #fff; border: none; cursor: pointer; }
  `;
  document.head.appendChild(style);
  document.body.appendChild(panelEl);

  // Build content grouped by prefix
  const content = document.getElementById('dev-panel-content')!;
  const groups = new Map<string, Map<string, number>>();

  for (const [path, value] of DEFAULTS_REGISTRY) {
    const prefix = path.split('.')[0];
    if (!groups.has(prefix)) groups.set(prefix, new Map());
    groups.get(prefix)!.set(path, value);
  }

  for (const [groupName, entries] of groups) {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'group';
    groupDiv.innerHTML = `<div class="group-title">${groupName}</div><div class="group-content"></div>`;
    const contentDiv = groupDiv.querySelector('.group-content')!;

    for (const [path, defaultValue] of entries) {
      const shortName = path.replace(`${groupName}.`, '');
      const row = document.createElement('div');
      row.className = 'row';
      row.innerHTML = `<label>${shortName}</label><input type="number" step="any" value="${defaultValue}" data-path="${path}">`;
      const input = row.querySelector('input')!;
      input.addEventListener('change', () => {
        const val = parseFloat(input.value);
        if (!isNaN(val)) {
          room.send('dev-tune', { path, value: val });
        }
      });
      contentDiv.appendChild(row);
    }

    content.appendChild(groupDiv);
  }

  // Reset button
  document.getElementById('dev-reset-btn')!.addEventListener('click', () => {
    room.send('dev-reset', {});
    // Reset all inputs to defaults
    for (const input of panelEl!.querySelectorAll('input[data-path]') as NodeListOf<HTMLInputElement>) {
      const path = input.dataset.path!;
      input.value = String(DEFAULTS_REGISTRY.get(path) || 0);
    }
  });

  // Toggle with backtick
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') {
      visible = !visible;
      panelEl!.style.display = visible ? 'block' : 'none';
    }
  });
}
