import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

/**
 * 开发服务器代理。
 *
 * 为什么需要：官方开奖接口要求带 Referer，而浏览器把 Referer 列为禁止修改的
 * 请求头，fetch 里设了也会被丢掉。代理在服务端补上这个头，顺便绕开 CORS，
 * 于是「更新数据」按钮在 npm run dev 下真的能拉到新期号。
 *
 * 生产环境静态部署没有代理，网页版依然只能靠内置数据包 —— 见 src/adapters/net.ts。
 */
const REF_DLT = 'https://www.lottery.gov.cn/kj/kjlb.html?dlt'
const REF_SSQ = 'https://www.cwl.gov.cn/ygkj/wqkjgg/ssq/'
// 体彩的 WAF 会对 HeadlessChrome 之类的 UA 直接回 567，代理统一盖成正常桌面 UA
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

export default defineConfig({
  plugins: [vue()],
  // base 必须为相对路径，否则 Capacitor 打包后 WebView 找不到资源
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    proxy: {
      '/__dlt': {
        target: 'https://webapi.sporttery.cn',
        changeOrigin: true,
        headers: { Referer: REF_DLT, 'User-Agent': UA },
        rewrite: (p) => p.replace(/^\/__dlt/, ''),
      },
      '/__ssq': {
        target: 'https://www.cwl.gov.cn',
        changeOrigin: true,
        headers: { Referer: REF_SSQ, 'User-Agent': UA },
        rewrite: (p) => p.replace(/^\/__ssq/, ''),
      },
    },
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1500,
  },
})
