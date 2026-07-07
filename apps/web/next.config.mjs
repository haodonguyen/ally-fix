/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Workspace packages ship raw TypeScript; let Next transpile them.
  transpilePackages: ["@ally-fix/shared", "@ally-fix/db", "@ally-fix/llm"],
  // Produces a minimal standalone server for the Docker image.
  output: "standalone",
};

export default nextConfig;
