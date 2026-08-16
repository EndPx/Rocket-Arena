/**
 * Rocket Arena — Client Entry Point
 *
 * This file bootstraps the Three.js renderer, networking,
 * input handling, and HUD. Currently a placeholder that
 * confirms the client builds and runs.
 */

const app = document.getElementById('app')!;

const info = document.createElement('div');
info.style.cssText = `
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #fff;
  font-family: monospace;
  font-size: 1.5rem;
`;
info.textContent = '🚀 Rocket Arena — Client Ready';
app.appendChild(info);

console.log('[Rocket Arena] Client initialized');
