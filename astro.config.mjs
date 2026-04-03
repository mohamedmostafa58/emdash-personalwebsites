import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2, sandbox } from "@emdash-cms/cloudflare";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { webhookNotifierPlugin } from "@emdash-cms/plugin-webhook-notifier";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { deployHook, deployHookPlugin } from "emdash-plugin-deploy-hook";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	vite: {
		resolve: {
			dedupe: ["emdash"],
			preserveSymlinks: true,
		},
	},
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto" }),
			storage: r2({ binding: "MEDIA" }),
			plugins: [formsPlugin(), deployHookPlugin()],
			sandboxed: [webhookNotifierPlugin()],
			sandboxRunner: sandbox(),
			marketplace: "https://marketplace.emdashcms.com",
			mcp: true,
		}),
		deployHook({ dynamic: ["/search", "/cf-manager"] }),
	],
	devToolbar: { enabled: false },
});
