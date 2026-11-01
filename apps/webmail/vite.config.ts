import adapter from "@sveltejs/adapter-node";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// The origin is fixed at build time and is also the CSRF origin (docs/webmail-auth.md).
const origin = process.env.ORIGIN;

export default defineConfig(() => {
  return {
    plugins: [
      {
        name: "require-origin",
        apply: "build",
        buildStart() {
          if (!origin)
            this.error(
              "Set ORIGIN for the build, e.g. https://webmail.survivus.com.br",
            );
        },
      },
      sveltekit({
        // BUILD_OUT only moves the output folder (the tests build a second copy with the
        // production ORIGIN); it changes nothing inside the build.
        adapter: adapter({ out: process.env.BUILD_OUT || "build" }),
        paths: origin ? { origin } : {},
        // csrf.trustedOrigins stays [] (the default): only our own origin may post forms. Never '*'.
        csp: {
          mode: "auto",
          directives: {
            "default-src": ["self"],
            "img-src": ["self", "data:"],
            "frame-ancestors": ["none"],
            "form-action": ["self"],
            "base-uri": ["none"],
            "object-src": ["none"],
          },
        },
      }),
    ],
    // Never --host or 0.0.0.0: the dev server is reached through an SSH tunnel.
    server: { host: "127.0.0.1", strictPort: true },
    preview: { host: "127.0.0.1" },
  };
});
