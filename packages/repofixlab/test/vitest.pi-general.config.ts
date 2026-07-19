import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: "@earendil-works/pi-coding-agent",
				replacement: fileURLToPath(new URL("../../coding-agent/src/index.ts", import.meta.url)),
			},
			{
				find: "@earendil-works/pi-ai/compat",
				replacement: fileURLToPath(new URL("../../ai/src/compat.ts", import.meta.url)),
			},
			{
				find: "@earendil-works/pi-ai/oauth",
				replacement: fileURLToPath(new URL("../../ai/src/oauth.ts", import.meta.url)),
			},
			{
				find: "@earendil-works/pi-ai",
				replacement: fileURLToPath(new URL("../../ai/src/index.ts", import.meta.url)),
			},
			{
				find: "@earendil-works/pi-agent-core",
				replacement: fileURLToPath(new URL("../../agent/src/index.ts", import.meta.url)),
			},
			{
				find: "@earendil-works/pi-tui",
				replacement: fileURLToPath(new URL("../../tui/src/index.ts", import.meta.url)),
			},
		],
	},
});
