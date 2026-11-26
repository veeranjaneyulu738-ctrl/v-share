import type { NextConfig } from "next";
import os from "os";

function getLocalDevOrigins(): string[] {
  const origins = new Set<string>(["127.0.0.1"]);
  const nets = os.networkInterfaces();
  for (const ifaces of Object.values(nets)) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) {
        origins.add(iface.address);
      }
    }
  }
  return Array.from(origins);
}

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: getLocalDevOrigins(),
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
