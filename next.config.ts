import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  reactCompiler: false,
  serverExternalPackages: ["discord.js", "@discordjs/ws", "@discordjs/rest", "better-sqlite3"],
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
