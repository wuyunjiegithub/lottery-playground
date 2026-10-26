// 探测脚本专用：让 pinia / vue 进入 Vite 的 SSR 模块图，
// 否则外部 import 到的与 store 内部用的不是同一个实例
// （ssrLoadModule 每次会建独立模块图，vue 更是压根加载不了）。
export { createPinia, setActivePinia } from 'pinia'
export { watch } from 'vue'
