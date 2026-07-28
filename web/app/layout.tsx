import type { Metadata, Viewport } from "next";
import { Space_Grotesk } from "next/font/google";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

/**
 * ICONOS: iOS **no** usa el favicon ni el <title> para el atajo de la pantalla
 * de inicio. Busca un `apple-touch-icon` PNG y, si no lo encuentra, guarda una
 * captura de la página como icono — que es lo que estaba pasando aquí: no
 * existía siquiera la carpeta `public/`.
 *
 * Tiene que ser PNG con fondo opaco: iOS ignora el SVG para este atajo y pinta
 * de negro lo transparente. Los ficheros salen de `Logo.tsx` rasterizado
 * (scripts/README no hace falta: `qlmanage -t -s 1024` + `sips -z`).
 *
 * El título del atajo es `short_name`/`appleWebApp.title` — "Interstellar
 * Options — Options AI" se cortaría a tres letras bajo el icono.
 */
export const metadata: Metadata = {
  title: "Interstellar Options — Options AI",
  description: "AI Options Agent — scorecard, flujo y predicción.",
  manifest: "/manifest.webmanifest",
  applicationName: "Interstellar Options",
  icons: {
    icon: [
      { url: "/icon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
  },
  appleWebApp: {
    capable: true,
    title: "Interstellar",
    statusBarStyle: "default",
  },
};

// Sin `viewportFit: "cover"` a propósito: así iOS mantiene el contenido dentro
// del área segura por su cuenta y no hace falta cablear `env(safe-area-inset-*)`
// en el CSS para que la cabecera no se meta bajo la muesca.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#17284A",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="es">
      <body className={spaceGrotesk.className}>{children}</body>
    </html>
  );
}
