/**
 * Cloudflare Manager — Sandbox Entry
 * Block Kit admin UI for domain management, cache rules, and purge.
 */

import { definePlugin } from "emdash";

const CF_API = "https://api.cloudflare.com/client/v4";

async function cfFetch(httpFetch: any, path: string, token: string, method = "GET", body?: unknown) {
	const res = await httpFetch(`${CF_API}${path}`, {
		method,
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
		body: body ? JSON.stringify(body) : undefined,
	});
	return (await res.json()) as { success: boolean; result?: any; errors?: any[] };
}

async function findZone(httpFetch: any, hostname: string, token: string) {
	const parts = hostname.split(".");
	for (let i = 0; i < parts.length - 1; i++) {
		const domain = parts.slice(i).join(".");
		const res = await cfFetch(httpFetch, `/zones?name=${domain}`, token);
		if (res.success && Array.isArray(res.result) && res.result.length > 0) {
			return { zoneId: res.result[0].id, zoneName: res.result[0].name };
		}
	}
	return null;
}

async function getRuleset(httpFetch: any, zoneId: string, token: string) {
	const list = await cfFetch(httpFetch, `/zones/${zoneId}/rulesets`, token);
	if (!list.success || !Array.isArray(list.result)) return null;
	const existing = list.result.find((rs: any) => rs.phase === "http_request_cache_settings");
	if (existing) return existing.id;
	const create = await cfFetch(httpFetch, `/zones/${zoneId}/rulesets`, token, "POST", {
		name: "EmDash Cache Rules", kind: "zone", phase: "http_request_cache_settings", rules: [],
	});
	return create.success ? create.result?.id : null;
}

async function createCacheRule(httpFetch: any, zoneId: string, hostname: string, token: string) {
	const rulesetId = await getRuleset(httpFetch, zoneId, token);
	if (!rulesetId) return { success: false };
	const rs = await cfFetch(httpFetch, `/zones/${zoneId}/rulesets/${rulesetId}`, token);
	if (rs.result?.rules?.some((r: any) => r.description === `EmDash Cache: ${hostname}`)) return { success: true };
	return await cfFetch(httpFetch, `/zones/${zoneId}/rulesets/${rulesetId}/rules`, token, "POST", {
		description: `EmDash Cache: ${hostname}`,
		expression: `(http.host eq "${hostname}" and not starts_with(http.request.uri.path, "/_emdash"))`,
		action: "set_cache_settings",
		action_parameters: { cache: true, edge_ttl: { mode: "override_origin", default: 31536000 }, browser_ttl: { mode: "override_origin", default: 0 } },
		enabled: true,
	});
}

async function removeCacheRule(httpFetch: any, zoneId: string, hostname: string, token: string) {
	const rulesetId = await getRuleset(httpFetch, zoneId, token);
	if (!rulesetId) return;
	const rs = await cfFetch(httpFetch, `/zones/${zoneId}/rulesets/${rulesetId}`, token);
	const rule = rs.result?.rules?.find((r: any) => r.description === `EmDash Cache: ${hostname}`);
	if (rule) await cfFetch(httpFetch, `/zones/${zoneId}/rulesets/${rulesetId}/rules/${rule.id}`, token, "DELETE");
}

async function getWorkerDomains(httpFetch: any, token: string, accountId: string, workerName: string) {
	if (!token || !accountId || !workerName) return [];
	const res = await cfFetch(httpFetch, `/accounts/${accountId}/workers/domains`, token);
	if (!res.success || !Array.isArray(res.result)) return [];
	return res.result.filter((d: any) => d.service === workerName).map((d: any) => ({
		id: d.id, hostname: d.hostname, zone_name: d.zone_name || "", zone_id: d.zone_id || "",
	}));
}

// ─── Plugin ─────────────────────────────────────────────────────

export default definePlugin({
	hooks: {
		"content:afterSave": {
			priority: 200, timeout: 15000, errorPolicy: "continue" as const,
			handler: async (_e: any, ctx: any) => {
				if (!(await ctx.kv.get("cache:active"))) return;
				const token = await ctx.kv.get("settings:apiToken");
				const raw = await ctx.kv.get("cache:zoneIds");
				const zoneIds = Array.isArray(raw) ? raw : [];
				if (!token || zoneIds.length === 0) return;
				const f = ctx.http?.fetch || fetch;
				for (const zoneId of zoneIds) await cfFetch(f, `/zones/${zoneId}/purge_cache`, token, "POST", { purge_everything: true });
				await ctx.kv.set("cache:lastPurge", new Date().toISOString());
			},
		},
		"content:afterDelete": {
			priority: 200, timeout: 15000, errorPolicy: "continue" as const,
			handler: async (_e: any, ctx: any) => {
				if (!(await ctx.kv.get("cache:active"))) return;
				const token = await ctx.kv.get("settings:apiToken");
				const raw = await ctx.kv.get("cache:zoneIds");
				const zoneIds = Array.isArray(raw) ? raw : [];
				if (!token || zoneIds.length === 0) return;
				const f = ctx.http?.fetch || fetch;
				for (const zoneId of zoneIds) await cfFetch(f, `/zones/${zoneId}/purge_cache`, token, "POST", { purge_everything: true });
				await ctx.kv.set("cache:lastPurge", new Date().toISOString());
			},
		},
		"media:afterUpload": {
			priority: 200, timeout: 15000, errorPolicy: "continue" as const,
			handler: async (_e: any, ctx: any) => {
				if (!(await ctx.kv.get("cache:active"))) return;
				const token = await ctx.kv.get("settings:apiToken");
				const raw = await ctx.kv.get("cache:zoneIds");
				const zoneIds = Array.isArray(raw) ? raw : [];
				if (!token || zoneIds.length === 0) return;
				const f = ctx.http?.fetch || fetch;
				for (const zoneId of zoneIds) await cfFetch(f, `/zones/${zoneId}/purge_cache`, token, "POST", { purge_everything: true });
				await ctx.kv.set("cache:lastPurge", new Date().toISOString());
			},
		},
	},

	routes: {
		admin: {
			handler: async (routeCtx: any, ctx: any) => {
				const interaction = routeCtx.input;
				const f = ctx.http?.fetch || fetch;
				let token = (await ctx.kv.get("settings:apiToken")) || "";
				let accountId = (await ctx.kv.get("settings:accountId")) || "";
				let workerName = (await ctx.kv.get("settings:workerName")) || "";
				const active = (await ctx.kv.get("cache:active")) ?? false;
				const lastPurge = (await ctx.kv.get("cache:lastPurge")) || "";

				// ─── Save settings ───
				if (interaction?.type === "form_submit" && interaction?.action_id === "save") {
					const v = interaction.values || {};
					if (v.apiToken) { token = v.apiToken; await ctx.kv.set("settings:apiToken", token); }
					if (v.accountId) { accountId = v.accountId; await ctx.kv.set("settings:accountId", accountId); }
					if (v.workerName) { workerName = v.workerName; await ctx.kv.set("settings:workerName", workerName); }
					return { blocks: await buildPage(f, token, accountId, workerName, active, lastPurge), toast: { message: "Settings saved!", type: "success" } };
				}

				// ─── Assign domain ───
				if (interaction?.type === "form_submit" && interaction?.action_id === "assign") {
					const hostname = interaction.values?.hostname;
					if (!hostname) return { blocks: await buildPage(f, token, accountId, workerName, active, lastPurge), toast: { message: "Enter a hostname", type: "error" } };
					const res = await cfFetch(f, `/accounts/${accountId}/workers/domains`, token, "PUT", { hostname, service: workerName, environment: "production" });
					return { blocks: await buildPage(f, token, accountId, workerName, active, lastPurge), toast: { message: res.success ? `${hostname} assigned!` : (res.errors?.[0]?.message || "Failed"), type: res.success ? "success" : "error" } };
				}

				// ─── Remove domain ───
				if (interaction?.action_id?.startsWith("rm_")) {
					const domainId = interaction.action_id.slice(3);
					await cfFetch(f, `/accounts/${accountId}/workers/domains/${domainId}`, token, "DELETE");
					return { blocks: await buildPage(f, token, accountId, workerName, active, lastPurge), toast: { message: "Domain removed", type: "success" } };
				}

				// ─── Activate ───
				if (interaction?.action_id === "activate") {
					const domains = await getWorkerDomains(f, token, accountId, workerName);
					const zoneIds: string[] = [];
					const msgs: string[] = [];
					for (const d of domains) {
						const z = await findZone(f, d.hostname, token);
						if (z) { await createCacheRule(f, z.zoneId, d.hostname, token); if (!zoneIds.includes(z.zoneId)) zoneIds.push(z.zoneId); msgs.push(d.hostname); }
					}
					await ctx.kv.set("cache:active", true);
					await ctx.kv.set("cache:zoneIds", zoneIds);
					return { blocks: await buildPage(f, token, accountId, workerName, true, lastPurge), toast: { message: `Cached: ${msgs.join(", ")}`, type: "success" } };
				}

				// ─── Deactivate ───
				if (interaction?.action_id === "deactivate") {
					const domains = await getWorkerDomains(f, token, accountId, workerName);
					for (const d of domains) { const z = await findZone(f, d.hostname, token); if (z) await removeCacheRule(f, z.zoneId, d.hostname, token); }
					await ctx.kv.set("cache:active", false);
					await ctx.kv.set("cache:zoneIds", []);
					return { blocks: await buildPage(f, token, accountId, workerName, false, lastPurge), toast: { message: "Deactivated", type: "success" } };
				}

				// ─── Purge ───
				if (interaction?.action_id === "purge") {
					const raw = await ctx.kv.get("cache:zoneIds");
					const zoneIds = Array.isArray(raw) ? raw : [];
					for (const zoneId of zoneIds) await cfFetch(f, `/zones/${zoneId}/purge_cache`, token, "POST", { purge_everything: true });
					await ctx.kv.set("cache:lastPurge", new Date().toISOString());
					return { blocks: await buildPage(f, token, accountId, workerName, active, new Date().toISOString()), toast: { message: "Cache purged!", type: "success" } };
				}

				// ─── Page load ───
				return { blocks: await buildPage(f, token, accountId, workerName, active, lastPurge) };
			},
		},

		status: {
			handler: async (routeCtx: any, ctx: any) => {
				return {
					hasToken: !!(await ctx.kv.get("settings:apiToken")),
					active: (await ctx.kv.get("cache:active")) ?? false,
					lastPurge: (await ctx.kv.get("cache:lastPurge")) ?? "",
				};
			},
		},

		purge: {
			handler: async (routeCtx: any, ctx: any) => {
				const token = await ctx.kv.get("settings:apiToken");
				const raw = await ctx.kv.get("cache:zoneIds");
				const zoneIds = Array.isArray(raw) ? raw : [];
				if (!token || zoneIds.length === 0) return { success: false, reason: "Not active" };
				const f = ctx.http?.fetch || fetch;
				for (const zoneId of zoneIds) await cfFetch(f, `/zones/${zoneId}/purge_cache`, token, "POST", { purge_everything: true });
				await ctx.kv.set("cache:lastPurge", new Date().toISOString());
				return { success: true };
			},
		},
	},
});

// ─── Block Kit page builder ─────────────────────────────────────

async function buildPage(f: any, token: string, accountId: string, workerName: string, active: boolean, lastPurge: string) {
	const blocks: any[] = [{ type: "header", text: "Cloudflare Manager" }];

	if (!token) {
		blocks.push(
			{ type: "banner", title: "Setup", description: "Enter your Cloudflare credentials to get started.", variant: "default" },
			{ type: "form", block_id: "setup", fields: [
				{ type: "secret_input", action_id: "apiToken", label: "API Token" },
				{ type: "text_input", action_id: "accountId", label: "Account ID" },
				{ type: "text_input", action_id: "workerName", label: "Worker Name" },
			], submit: { label: "Save", action_id: "save" } },
		);
		return blocks;
	}

	// Status
	const fields: any[] = [
		{ label: "Token", value: "Set" },
		{ label: "Account", value: accountId ? `...${accountId.slice(-8)}` : "Not set" },
		{ label: "Worker", value: workerName || "Not set" },
		{ label: "Cache", value: active ? "Active" : "Inactive" },
	];
	if (lastPurge) fields.push({ label: "Last Purge", value: new Date(lastPurge).toLocaleString() });
	blocks.push({ type: "fields", fields });

	// Load domains if configured
	if (token && accountId && workerName) {
		try {
			const domains = await getWorkerDomains(f, token, accountId, workerName);

			// Check cache rules
			const domainRows: any[] = [];
			for (const d of domains) {
				let cached = false;
				if (d.zone_id) {
					const rulesetId = await getRuleset(f, d.zone_id, token);
					if (rulesetId) {
						const rs = await cfFetch(f, `/zones/${d.zone_id}/rulesets/${rulesetId}`, token);
						cached = rs.result?.rules?.some((r: any) => r.description === `EmDash Cache: ${d.hostname}`) ?? false;
					}
				}
				domainRows.push({ hostname: d.hostname, zone: d.zone_name, status: cached ? "Cached" : "Not cached", id: d.id });
			}

			blocks.push({ type: "divider" }, { type: "header", text: `Domains (${domains.length})` });

			if (domainRows.length > 0) {
				blocks.push({
					type: "table",
					columns: [{ key: "hostname", label: "Domain" }, { key: "zone", label: "Zone" }, { key: "status", label: "Cache" }],
					rows: domainRows,
				});

				// Remove buttons
				blocks.push({
					type: "actions",
					elements: domainRows.map((d) => ({
						type: "button", text: `Remove ${d.hostname}`, action_id: `rm_${d.id}`,
						confirm: { title: `Remove ${d.hostname}?`, text: "Detach domain from worker", confirm: "Remove", deny: "Cancel" },
					})),
				});
			} else {
				blocks.push({ type: "context", text: "No domains attached. Assign one below." });
			}
		} catch {}

		// Assign domain form
		blocks.push(
			{ type: "divider" },
			{ type: "form", block_id: "assign_form", fields: [
				{ type: "text_input", action_id: "hostname", label: "Assign Domain", placeholder: "blog.yourdomain.com" },
			], submit: { label: "Assign", action_id: "assign" } },
		);

		// Cache actions
		blocks.push({ type: "divider" });
		const actions: any[] = [];
		if (!active) actions.push({ type: "button", text: "Activate Caching", action_id: "activate", style: "primary" });
		if (active) actions.push({ type: "button", text: "Purge Cache", action_id: "purge", style: "primary" });
		if (active) actions.push({ type: "button", text: "Deactivate", action_id: "deactivate", style: "danger", confirm: { title: "Deactivate?", text: "Remove all cache rules", confirm: "Yes", deny: "No" } });
		if (actions.length > 0) blocks.push({ type: "actions", elements: actions });
	}

	// Settings form (always at bottom)
	blocks.push(
		{ type: "divider" },
		{ type: "header", text: "Settings" },
		{ type: "form", block_id: "settings", fields: [
			{ type: "secret_input", action_id: "apiToken", label: "API Token", placeholder: "Enter new to replace" },
			{ type: "text_input", action_id: "accountId", label: "Account ID", initial_value: accountId },
			{ type: "text_input", action_id: "workerName", label: "Worker Name", initial_value: workerName },
		], submit: { label: "Update", action_id: "save" } },
	);

	return blocks;
}
