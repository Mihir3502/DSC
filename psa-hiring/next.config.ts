import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Agent instructions live in the repository's approved CLAUDE.md and
  // AGENTS.md; stop `next dev` from generating its own copies here.
  agentRules: false,
  experimental: {
    // The proxy truncates larger bodies. This equals MAX_UPLOAD_REQUEST_BYTES:
    // one 10 MB attachment plus multipart overhead (packet M2.5).
    proxyClientMaxBodySize: 10 * 1024 * 1024 + 64 * 1024,
  },
};

export default nextConfig;
