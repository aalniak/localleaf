// Import a zip into the local project store without the browser:
//   npm run import -- path/to/project.zip ["Project name"]
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../server/config.js';
import { ProjectStore } from '../server/projects/store.js';
import { readZipEntries } from '../server/projects/zipImport.js';

const [zipPath, name] = process.argv.slice(2);
if (!zipPath) {
  console.error('Usage: npm run import -- <file.zip> ["Project name"]');
  process.exit(1);
}

try {
  const store = new ProjectStore(loadConfig().dataDir);
  await store.init();
  const entries = readZipEntries(await fs.readFile(zipPath));
  const meta = await store.create({ name: name || path.basename(zipPath, '.zip').replace(/_+/g, ' '), entries });
  console.log(`Imported "${meta.name}" (${entries.length} files, main document: ${meta.mainFile ?? 'none'})`);
} catch (err) {
  console.error(`Import failed: ${err.message}`);
  process.exit(1);
}
