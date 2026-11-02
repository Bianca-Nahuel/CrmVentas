import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // SWC emite la metadata de decoradores que Nest necesita para la inyección de dependencias.
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    // Los e2e comparten la base local: un archivo a la vez.
    fileParallelism: false,
    // Sin aislar los archivos: los módulos (Nest, Drizzle, pg-boss…) se cargan una vez y no en cada
    // archivo (~100 s menos). Cada archivo levanta su propia app con startTestContext.
    isolate: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
