import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Pin the monorepo root so Turbopack doesn't pick up an unrelated lockfile elsewhere.
  turbopack: { root: repoRoot },
  // Workspace packages ship raw TypeScript; let Next transpile them.
  transpilePackages: ["@ally-fix/shared", "@ally-fix/db", "@ally-fix/llm"],
  // Node-only libraries used in route handlers — keep them out of the bundle.
  serverExternalPackages: ["bullmq", "ioredis", "postgres"],
  // Produces a minimal standalone server for the Docker image.
  output: "standalone",
};

export default nextConfig;
