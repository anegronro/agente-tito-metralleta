/**
 * Marca de Interstellar Options: flecha ascendente con veta verde, cruzando
 * una órbita partida.
 *
 * Colores tomados del logo real (azul marino + verde), no de la guía dorada:
 * el verde ya es el color de "call / subida" en esta app, así que la marca
 * queda coherente con el resto de la interfaz en vez de pelearse con ella.
 *
 * OJO CON EL TAMAÑO: en la cabecera esto se dibuja a 30px. Los puntitos de
 * estrellas del logo original son de radio ~4 sobre un lienzo de 200 — a ese
 * tamaño miden medio píxel y desaparecen. Aquí se conservan solo los tres más
 * grandes y el resto se deja fuera: un detalle invisible no es un detalle, es
 * suciedad. La versión grande sigue leyéndose bien sin ellos.
 */
const NAVY = "#17284A";
const VERDE = "#3ED662";

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
      {/* Órbita partida: dos tramos opuestos, no un anillo cerrado. */}
      <path
        d="M 62 44 A 72 72 0 0 0 44 128"
        stroke={NAVY}
        strokeWidth="13"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M 156 78 A 72 72 0 0 1 92 166"
        stroke={NAVY}
        strokeWidth="13"
        strokeLinecap="round"
        fill="none"
      />

      {/* Cuerpo de la flecha: barra gruesa en marino de esquina a esquina. */}
      <line
        x1="42" y1="158" x2="140" y2="60"
        stroke={NAVY}
        strokeWidth="30"
        strokeLinecap="butt"
      />

      {/* Veta verde por dentro — la firma del logo. */}
      <line
        x1="42" y1="158" x2="134" y2="66"
        stroke={VERDE}
        strokeWidth="9"
        strokeLinecap="butt"
      />

      {/* Punta sólida. */}
      <path d="M 108 44 L 166 34 L 156 92 Z" fill={NAVY} />

      {/* Solo las estrellas que sobreviven a 30px. */}
      <circle cx="76" cy="62" r="7" fill={NAVY} />
      <circle cx="132" cy="132" r="8" fill={NAVY} />
      <circle cx="104" cy="152" r="5" fill={NAVY} />
    </svg>
  );
}
