/** @type {import('next').NextConfig} */
const nextConfig = {
  // Exportação estática: o hub local serve os arquivos, sem servidor Next no Mac.
  output: 'export',
  trailingSlash: true,
  images: { unoptimized: true },
  transpilePackages: ['@claude-hub/shared'],
  reactStrictMode: true,
};
export default nextConfig;
