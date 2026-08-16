import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@rocket-arena/shared': resolve(__dirname, '../shared/src'),
    },
  },
  server: {
    port: 3000,
    fs: {
      // Allow serving files from the parent directory (monorepo root)
      // This is needed because shared/ is outside client/
      allow: [
        resolve(__dirname, '..'),
      ],
    },
  },
});
