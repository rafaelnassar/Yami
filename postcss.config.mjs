import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/** Tailwind config is resolved from the repo root because Vite's root is `src/renderer`. */
export default {
  plugins: {
    tailwindcss: { config: path.join(rootDir, 'tailwind.config.ts') },
    autoprefixer: {}
  }
};
