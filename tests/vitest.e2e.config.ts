import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        globals: true,
        include: ['tests/supabase/e2e/**/*.e2e.ts'],
        testTimeout: 420_000,
        hookTimeout: 60_000,
    },
});
