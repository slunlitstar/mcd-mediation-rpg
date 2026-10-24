import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

const envDir = fileURLToPath(new URL('../../', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, 'SERVER_');

  return {
    plugins: [react()],
    envDir,
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://${env.SERVER_HOST || '127.0.0.1'}:${env.SERVER_PORT || '3001'}`,
          changeOrigin: true
        }
      }
    }
  };
});
