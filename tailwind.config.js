/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  theme: {
    extend: {
      colors: {
        ink: {
          900: '#0e1014',
          800: '#14171d',
          700: '#181c24',
          600: '#1e232c',
          500: '#262c37',
        },
        gold: '#f5b944',
        up: '#ff4d4f',
        down: '#2fbf71',
      },
    },
  },
  plugins: [],
}
