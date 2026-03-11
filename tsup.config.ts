import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    external: ['koffi'],
  },
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    splitting: false,
    sourcemap: true,
    external: ['koffi'],
    banner: {
      js: "import { createRequire } from 'module';import { fileURLToPath } from 'url';import { dirname } from 'path';const require = createRequire(import.meta.url);const __filename = fileURLToPath(import.meta.url);const __dirname = dirname(__filename);",
    },
  },
])
