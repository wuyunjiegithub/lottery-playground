import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.playground.lottery',
  appName: '概率游乐场',
  webDir: 'dist',
  // 单机版：所有数据存本地，WebView 直接加载打包进 APK 的前端资源
  server: { androidScheme: 'https' },
  android: {
    allowMixedContent: true,
  },
}

export default config
