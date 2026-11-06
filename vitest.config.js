import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['server/**/*.js', 'scripts/setupLib.js', 'web/src/editor/completions.js', 'web/src/editor/fileTree.js'],
      exclude: ['server/index.js'],
    },
  },
});
