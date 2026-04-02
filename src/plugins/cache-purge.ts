/**
 * Cloudflare Manager — Trusted Plugin
 * Domain assignment + cache rules + auto-purge
 */

import type { PluginDescriptor } from "emdash";
import { definePlugin } from "emdash";

const CF_API = "https://api.cloudflare.com/client/v4";

async function cfFetch(path: string, token: string, method = "GET", body?: unknown) {
	const res = await fetch(`${CF_API}${path}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	return (await res.json()) as { success: boolean; result?: any; errors?: any[] };
}

async function findZone(hostname: string, token: string) {
	const parts = hostname.split(".");
	for (let i = 0; i < parts.length - 1; i++) {
		const domain = parts.slice(i).join(".");
		const res = await cfFetch(`/zones?name=${domain}`, token);
		if (res.success && Array.isArray(res.result) && res.result.length > 0)
			return { zoneId: res.result[0].id, zoneName: res.result[0].name };
	}
	return null;
}

async function getRuleset(zoneId: string, token: string) {
	const list = await cfFetch(`/zones/${zoneId}/rulesets`, token);
	if (!list.success || !Array.isArray(list.result)) return null;
	const existing = list.result.find((rs: any) => rs.phase === "http_request_cache_settings");
	if (existing) return existing.id;
	const create = await cfFetch(`/zones/${zoneId}/rulesets`, token, "POST", {
		name: "EmDash Cache Rules", kind: "zone", phase: "http_request_cache_settings", rules: [],
	});
	return create.success ? create.result?.id : null;
}

async function createCacheRule(zoneId: string, hostname: string, token: string) {
	const rulesetId = await getRuleset(zoneId, token);
	if (!rulesetId) return { success: false };
	const rs = await cfFetch(`/zones/${zoneId}/rulesets/${rulesetId}`, token);
	if (rs.result?.rules?.some((r: any) => r.description === `EmDash Cache: ${hostname}`)) return { success: true };
	return await cfFetch(`/zones/${zoneId}/rulesets/${rulesetId}/rules`, token, "POST", {
		description: `EmDash Cache: ${hostname}`,
		expression: `(http.host eq "${hostname}" and not starts_with(http.request.uri.path, "/_emdash"))`,
		action: "set_cache_settings",
		action_parameters: { cache: true, edge_ttl: { mode: "override_origin", default: 31536000 }, browser_ttl: { mode: "override_origin", default: 0 } },
		enabled: true,
	});
}

async function removeCacheRule(zoneId: string, hostname: string, token: string) {
	const rulesetId = await getRuleset(zoneId, token);
	if (!rulesetId) return;
	const rs = await cfFetch(`/zones/${zoneId}/rulesets/${rulesetId}`, token);
	const rule = rs.result?.rules?.find((r: any) => r.description === `EmDash Cache: ${hostname}`);
	if (rule) await cfFetch(`/zones/${zoneId}/rulesets/${rulesetId}/rules/${rule.id}`, token, "DELETE");
}

async function getWorkerDomains(token: string, accountId: string, workerName: string) {
	if (!token || !accountId || !workerName) return [];
	const res = await cfFetch(`/accounts/${accountId}/workers/domains`, token);
	if (!res.success || !Array.isArray(res.result)) return [];
	return res.result.filter((d: any) => d.service === workerName)
		.map((d: any) => ({ id: d.id, hostname: d.hostname, zone_name: d.zone_name || "", zone_id: d.zone_id || "" }));
}

export { cfFetch, findZone, createCacheRule, removeCacheRule, getWorkerDomains };

// ─── Plugin ─────────────────────────────────────────────────────

export function cfManagerPlugin(): PluginDescriptor {
	return {
		id: "cf-manager",
		version: "5.1.0",
		entrypoint: "@local/cf-manager",
		capabilities: ["network:fetch:any"],
		adminPages: [{ path: "/settings", label: "Cloudflare Manager" }],
	};
}

export function createPlugin() {
	return definePlugin({
		id: "cf-manager",
		version: "5.1.0",
		capabilities: ["network:fetch:any"],

		hooks: {
			"content:afterSave": {
				priority: 200, timeout: 15000, errorPolicy: "continue" as const,
				handler: async (_e: any, ctx: any) => {
					if (!(await ctx.kv.get("cache:active"))) return;
					const token = await ctx.kv.get("settings:apiToken") as string;
					const raw = await ctx.kv.get("cache:zoneIds");
					const zoneIds = Array.isArray(raw) ? raw : [];
					if (!token || zoneIds.length === 0) return;
					for (const zid of zoneIds) await cfFetch(`/zones/${zid}/purge_cache`, token, "POST", { purge_everything: true });
					await ctx.kv.set("cache:lastPurge", new Date().toISOString());
				},
			},
			"content:afterDelete": {
				priority: 200, timeout: 15000, errorPolicy: "continue" as const,
				handler: async (_e: any, ctx: any) => {
					if (!(await ctx.kv.get("cache:active"))) return;
					const token = await ctx.kv.get("settings:apiToken") as string;
					const raw = await ctx.kv.get("cache:zoneIds");
					const zoneIds = Array.isArray(raw) ? raw : [];
					if (!token || zoneIds.length === 0) return;
					for (const zid of zoneIds) await cfFetch(`/zones/${zid}/purge_cache`, token, "POST", { purge_everything: true });
					await ctx.kv.set("cache:lastPurge", new Date().toISOString());
				},
			},
			"media:afterUpload": {
				priority: 200, timeout: 15000, errorPolicy: "continue" as const,
				handler: async (_e: any, ctx: any) => {
					if (!(await ctx.kv.get("cache:active"))) return;
					const token = await ctx.kv.get("settings:apiToken") as string;
					const raw = await ctx.kv.get("cache:zoneIds");
					const zoneIds = Array.isArray(raw) ? raw : [];
					if (!token || zoneIds.length === 0) return;
					for (const zid of zoneIds) await cfFetch(`/zones/${zid}/purge_cache`, token, "POST", { purge_everything: true });
					await ctx.kv.set("cache:lastPurge", new Date().toISOString());
				},
			},
		},

		routes: {
			admin: {
				handler: async (ctx: any) => {
					try {
						const interaction = ctx.input as any;
						const token = (await ctx.kv.get("settings:apiToken")) as string || "";
						const accountId = (await ctx.kv.get("settings:accountId")) as string || "";
						const workerName = (await ctx.kv.get("settings:workerName")) as string || "";
						const active = (await ctx.kv.get("cache:active")) ?? false;
						const lastPurge = (await ctx.kv.get("cache:lastPurge")) as string || "";

						// Save
						if (interaction?.type === "form_submit" && interaction?.action_id === "save") {
							const v = interaction.values || {};
							if (v.apiToken) await ctx.kv.set("settings:apiToken", v.apiToken);
							if (v.accountId) await ctx.kv.set("settings:accountId", v.accountId);
							if (v.workerName) await ctx.kv.set("settings:workerName", v.workerName);
							return {
								blocks: [
									{ type: "header", text: "Cloudflare Manager" },
									{ type: "banner", title: "Settings saved!", variant: "default" },
									{ type: "section", text: "Open the **[Dashboard](/cf-manager)** to manage domains, cache, and purge." },
								],
								toast: { message: "Saved!", type: "success" },
							};
						}

						// Page load
						const blocks: any[] = [
							{ type: "header", text: "Cloudflare Manager" },
							{
								type: "fields",
								fields: [
									{ label: "Token", value: token ? "Set" : "Not set" },
									{ label: "Account", value: accountId || "Not set" },
									{ label: "Worker", value: workerName || "Not set" },
									{ label: "Cache", value: active ? "Active" : "Off" },
								],
							},
						];

						if (lastPurge) {
							blocks.push({ type: "context", text: "Last purge: " + lastPurge });
						}

						blocks.push(
							{ type: "divider" },
							{ type: "section", text: "Use the **[full dashboard](/cf-manager)** to assign domains, activate caching, and purge." },
							{ type: "divider" },
							{
								type: "form",
								block_id: "settings",
								fields: [
									{ type: "secret_input", action_id: "apiToken", label: "API Token", placeholder: token ? "Enter new to replace" : "Enter token" },
									{ type: "text_input", action_id: "accountId", label: "Account ID", initial_value: accountId },
									{ type: "text_input", action_id: "workerName", label: "Worker Name", initial_value: workerName },
								],
								submit: { label: "Save", action_id: "save" },
							},
						);

						return { blocks };
					} catch (err) {
						return {
							blocks: [
								{ type: "header", text: "Cloudflare Manager" },
								{ type: "banner", title: "Error", description: String(err), variant: "error" },
							],
						};
					}
				},
			},

			"settings/save": {
				handler: async (ctx: any) => {
					const input = ctx.input as Record<string, unknown>;
					if (input.apiToken) await ctx.kv.set("settings:apiToken", input.apiToken);
					if (input.accountId) await ctx.kv.set("settings:accountId", input.accountId);
					if (input.workerName) await ctx.kv.set("settings:workerName", input.workerName);
					return { success: true };
				},
			},
			debug: {
				handler: async (ctx: any) => {
					const token = await ctx.kv.get("settings:apiToken") as string;
					const accountId = await ctx.kv.get("settings:accountId") as string;
					const workerName = await ctx.kv.get("settings:workerName") as string;
					const active = await ctx.kv.get("cache:active");
					const zoneIds = await ctx.kv.get("cache:zoneIds");
					const lastPurge = await ctx.kv.get("cache:lastPurge");
					let domains: any[] = [];
					if (token && accountId && workerName) {
						try { domains = await getWorkerDomains(token, accountId, workerName); } catch {}
					}
					return { config: { hasToken: !!token, accountId, workerName }, cache: { active, zoneIds, lastPurge }, domains };
				},
			},
			status: {
				handler: async (ctx: any) => ({
					hasToken: !!(await ctx.kv.get("settings:apiToken")),
					active: (await ctx.kv.get("cache:active")) ?? false,
					lastPurge: (await ctx.kv.get("cache:lastPurge")) ?? "",
				}),
			},
			domains: {
				handler: async (ctx: any) => {
					const token = await ctx.kv.get("settings:apiToken") as string;
					const accountId = await ctx.kv.get("settings:accountId") as string;
					const workerName = await ctx.kv.get("settings:workerName") as string;
					if (!token || !accountId || !workerName) return { success: false, reason: "Missing config" };
					return { success: true, domains: await getWorkerDomains(token, accountId, workerName) };
				},
			},
			assign: {
				handler: async (ctx: any) => {
					const token = await ctx.kv.get("settings:apiToken") as string;
					const accountId = await ctx.kv.get("settings:accountId") as string;
					const workerName = await ctx.kv.get("settings:workerName") as string;
					if (!token || !accountId || !workerName) return { success: false, reason: "Missing config" };
					const { hostname } = ctx.input as { hostname: string };
					return await cfFetch(`/accounts/${accountId}/workers/domains`, token, "PUT", { hostname, service: workerName, environment: "production" });
				},
			},
			"domain/remove": {
				handler: async (ctx: any) => {
					const token = await ctx.kv.get("settings:apiToken") as string;
					const accountId = await ctx.kv.get("settings:accountId") as string;
					const { domainId } = ctx.input as { domainId: string };
					return await cfFetch(`/accounts/${accountId}/workers/domains/${domainId}`, token, "DELETE");
				},
			},
			activate: {
				handler: async (ctx: any) => {
					const token = await ctx.kv.get("settings:apiToken") as string;
					const accountId = await ctx.kv.get("settings:accountId") as string;
					const workerName = await ctx.kv.get("settings:workerName") as string;
					if (!token || !accountId || !workerName) return { success: false, reason: "Missing config" };
					const domains = await getWorkerDomains(token, accountId, workerName);
					const zoneIds: string[] = [];
					const results: any[] = [];
					for (const d of domains) {
						const z = await findZone(d.hostname, token);
						if (z) { await createCacheRule(z.zoneId, d.hostname, token); if (!zoneIds.includes(z.zoneId)) zoneIds.push(z.zoneId); results.push({ hostname: d.hostname, cached: true }); }
						else results.push({ hostname: d.hostname, cached: false, error: "Zone not found" });
					}
					await ctx.kv.set("cache:active", true);
					await ctx.kv.set("cache:zoneIds", zoneIds);
					return { success: true, results };
				},
			},
			deactivate: {
				handler: async (ctx: any) => {
					const token = await ctx.kv.get("settings:apiToken") as string;
					const accountId = await ctx.kv.get("settings:accountId") as string;
					const workerName = await ctx.kv.get("settings:workerName") as string;
					const domains = await getWorkerDomains(token, accountId, workerName);
					for (const d of domains) { const z = await findZone(d.hostname, token); if (z) await removeCacheRule(z.zoneId, d.hostname, token); }
					await ctx.kv.set("cache:active", false);
					await ctx.kv.set("cache:zoneIds", []);
					return { success: true };
				},
			},
			purge: {
				handler: async (ctx: any) => {
					const token = await ctx.kv.get("settings:apiToken") as string;
					const raw = await ctx.kv.get("cache:zoneIds");
					const zoneIds = Array.isArray(raw) ? raw : [];
					if (!token || zoneIds.length === 0) return { success: false, reason: "Not active" };
					for (const zid of zoneIds) await cfFetch(`/zones/${zid}/purge_cache`, token, "POST", { purge_everything: true });
					await ctx.kv.set("cache:lastPurge", new Date().toISOString());
					return { success: true };
				},
			},
		},
	});
}
