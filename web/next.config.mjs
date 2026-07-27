/** @type {import('next').NextConfig} */
const nextConfig = {
  // Empaqueta el servidor con solo las dependencias que de verdad usa, en
  // `.next/standalone`. Es lo que hace viable el VPS: allí `next build`
  // moriría por memoria (1 vCPU / 961MB con otros dos agentes corriendo), así
  // que se construye en el Mac y se sube el resultado, que arranca con
  // `node server.js` sin instalar node_modules en el servidor.
  output: "standalone",

  // `standalone` rastrea los ficheros que el servidor podría abrir y los copia
  // al bundle. Como lib/schwab.ts y los stores leen de `data/`, se llevaba la
  // carpeta ENTERA — incluido `schwab-tokens.json` con el refresh token dentro.
  // Pasó de verdad: el refresh acabó en el VPS en el primer despliegue.
  // `data/` es estado en tiempo de ejecución, nunca parte del artefacto.
  outputFileTracingExcludes: {
    "*": ["./data/**"],
  },
};

export default nextConfig;
