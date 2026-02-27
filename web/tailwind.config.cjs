/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0B1318",
        slate: "#13202A",
        panel: "#102532",
        mist: "#EAF5FF",
        accent: "#18C5A9",
        ember: "#FF7A2D",
        warning: "#FFC145"
      },
      boxShadow: {
        lift: "0 24px 80px rgba(0, 0, 0, 0.3)"
      }
    }
  },
  plugins: []
};
