import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2, sandbox } from "@emdash-cms/cloudflare";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { webhookNotifierPlugin } from "@emdash-cms/plugin-webhook-notifier";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { cfManagerPlugin } from "./src/plugins/cache-purge";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	vite: {
		resolve: {
			alias: {
				"@local/cf-manager": new URL("./src/plugins/cache-purge.ts", import.meta.url).pathname,
			},
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
			plugins: [formsPlugin(), cfManagerPlugin()],
			sandboxed: [webhookNotifierPlugin()],
			sandboxRunner: sandbox(),
			marketplace: "https://marketplace.emdashcms.com",
			mcp: true,
		}),
	],
	devToolbar: { enabled: false },
});
