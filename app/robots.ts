import type { MetadataRoute } from "next";

// Internal staff dashboard — block every crawler. Keeps the login page,
// brand metadata, and any leaked URLs out of search results.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", disallow: "/" }],
  };
}
