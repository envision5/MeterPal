/** @type {import('tailwindcss').Config} */
module.exports = {
	// Class, not `media`: the storefront is always dark, and the SDK components
	// bundled into it are written for a light *or* dark host
	// (`text-emerald-700 dark:text-emerald-300`). Under the default media
	// strategy a light-mode OS picked the light-host shade and rendered it on a
	// dark page. `<html class="dark">` makes the dark half apply.
	darkMode: "class",
	content: ["./index.html", "./src/**/*.{ts,tsx}", "../sdk/typescript/src/**/*.{ts,tsx}"],
	theme: {
		extend: {
			colors: {
				border: "hsl(var(--border))",
				background: "hsl(var(--background))",
				foreground: "hsl(var(--foreground))",
				primary: {
					DEFAULT: "hsl(var(--primary))",
					foreground: "hsl(var(--primary-foreground))",
				},
				muted: {
					DEFAULT: "hsl(var(--muted))",
					foreground: "hsl(var(--muted-foreground))",
				},
			},
		},
	},
	plugins: [],
};
