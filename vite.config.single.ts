import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { fileURLToPath, URL } from 'node:url'

/**
 * 单文件网页版构建：把所有 JS / CSS / 数据内联进一个 index.html。
 * 产出可以直接双击打开（file:// 也能跑），或丢到任意静态托管。
 *
 *   npm run build:single  →  dist-single/index.html
 */
export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2020',
    outDir: 'dist-single',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000, // 全部内联
    chunkSizeWarningLimit: 8000,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined,
      },
    },
  },
})
