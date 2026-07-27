/**
 * Marca de Interstellar Options: órbita + flecha ascendente + nodos.
 *
 * Dos ajustes respecto al boceto original de la guía de marca:
 *
 * 1. El trazo grueso bajo la flecha era BLANCO, pensado para fondo oscuro.
 *    Sobre el tema claro de esta app sería invisible y la flecha perdería su
 *    contorno, así que usa el azul marino de la paleta (#1E2640) — cumple la
 *    misma función de halo, pero al revés.
 * 2. El boceto comentaba con `#` dentro del SVG. Eso no es un comentario en
 *    HTML/SVG: se renderizaría como texto suelto encima del dibujo.
 *
 * `currentColor` no se usa a propósito: la marca es de color fijo.
 */
export default function Logo({ size = 30 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 200 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Interstellar Options"
    >
      {/* Arco orbital exterior */}
      <path
        d="M 40 100 A 60 60 0 1 1 150 140"
        stroke="#1E2640"
        strokeWidth="8"
        strokeLinecap="round"
      />
      <path
        d="M 160 100 A 60 60 0 0 1 50 150"
        stroke="#D4AF37"
        strokeWidth="8"
        strokeLinecap="round"
      />

      {/* Flecha diagonal: trazo grueso de contorno + dorado encima */}
      <line
        x1="45" y1="155" x2="145" y2="55"
        stroke="#1E2640"
        strokeWidth="12"
        strokeLinecap="round"
      />
      <line
        x1="45" y1="155" x2="145" y2="55"
        stroke="#D4AF37"
        strokeWidth="6"
        strokeLinecap="round"
      />

      {/* Punta de flecha */}
      <path d="M 125 45 L 160 40 L 155 75 Z" fill="#D4AF37" />

      {/* Nodos / planetas */}
      <circle cx="120" cy="150" r="7" fill="#8E95A5" />
      <circle cx="65" cy="65" r="5" fill="#8E95A5" />
    </svg>
  );
}
