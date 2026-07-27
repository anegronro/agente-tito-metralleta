/** @type {import('next').NextConfig} */
const nextConfig = {
  // Empaqueta el servidor con solo las dependencias que de verdad usa, en
  // `.next/standalone`. Es lo que hace viable el VPS: allí `next build`
  // moriría por memoria (1 vCPU / 961MB con otros dos agentes corriendo), así
  // que se construye en el Mac y se sube el resultado, que arranca con
  // `node server.js` sin instalar node_modules en el servidor.
  output: "standalone",
};

export default nextConfig;
