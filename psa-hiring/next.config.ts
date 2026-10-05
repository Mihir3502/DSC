import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Agent instructions live in the repository's approved CLAUDE.md and
  // AGENTS.md; stop `next dev` from generating its own copies here.
  agentRules: false,
};

export default nextConfig;
