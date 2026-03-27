/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Poppins', 'sans-serif'],
        brand: ['Poppins', 'sans-serif'],
      },
      colors: {
        brand: '#00dc41',
        darkBG: '#111319',
        card: '#1b1d23',
        grayText: '#8a8d9b'
      }
    },
  },
  plugins: [],
}
