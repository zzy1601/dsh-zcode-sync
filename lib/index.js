/**
 * dsh-zcode-sync — ZCode → DSH 模型配置同步插件
 *
 * 移植自独立脚本 sync-zcode-to-dsh.cjs，改造为 DSH 进程内插件：
 *  - 不再直接读写 settings.yaml / .credentials.yaml 文件；
 *    改走进程内 settings 服务（merge 写入 llm-pi-ai 命名空间，
 *    由 llm-pi-ai 自带的 assertServiceable 校验把关——非法配置被拒绝
 *    而不是写坏文件搞崩整个命名空间注册）与凭据服务（credentials.write）。
 *  - 零硬编码机器路径：ZCode 配置默认 <homedir>/.zcode/v2/config.json，
 *    可在插件设置里覆盖。
 *  - 触发时机：启动延迟跑一次 + 可选周期同步 + 插件配置变更时立即重跑。
 *  - 幂等：目标状态与现状一致则不发起写入。
 *
 * 设置命名空间：zcode-sync（web 设置页可见）。
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import z from "@deepseek-ai/schemastery";

export const name = "zcode-sync";

// 与 dsh-web-tools 同构的服务声明：保证 settings/credentials 在本插件
// apply 之前实例化，之后用 ctx.settings / ctx.credentials 属性访问。
export const inject = ["settings", "credentials"];

// ── 设置 schema ────────────────────────────────────────────────────────────
const Config = z.object({
	/** 总开关。关闭后不再自动同步（手动触发也不可用时以此为准）。 */
	enabled: z.boolean().default(true),
	/** ZCode config.json 路径。留空 = <用户主目录>/.zcode/v2/config.json，支持 ~ 开头。 */
	zcodeConfigPath: z.string().default(""),
	/** DSH 启动后延迟跑第一次同步。 */
	runOnStart: z.boolean().default(true),
	/** 首次同步延迟毫秒数（等 llm-pi-ai 等服务就绪）。 */
	startDelayMs: z.number().step(1).min(0).default(8000),
	/** 周期同步间隔分钟；0 = 不周期同步（仅启动一次 + 配置变更时）。 */
	syncIntervalMinutes: z.number().step(1).min(0).default(0),
	/** 只计算差异并打日志，不实际写入。 */
	dryRun: z.boolean().default(false),
	/** 额外的 ZCode provider id → DSH 路由键映射（内置映射之外的补充）。 */
	extraProviderMap: z.dict(z.string()).default({}),
});

// ── ZCode variant → DSH reasoningEfforts 映射 ─────────────────────────────
// null = 请求时不发送推理参数（相当于关闭思考）。
// llm-pi-ai schema 的 effort key 只接受 off|minimal|low|medium|high|xhigh|max，
// 因此 ZCode 的 none（关闭思考）映射到 off，enabled（开启思考）映射到 high。
const REASONING_KEY_MAP = { none: "off", off: "off", enabled: "high" };
const REASONING_VALUE_MAP = { off: null, none: null, enabled: "high" };

// ── ZCode provider ID → DSH 路由键 内置映射 ────────────────────────────────
// 未命中时按 provider.name 自动生成 slug 键（幂等），也可用设置里的
// extraProviderMap 补充，无需改代码。
const DEFAULT_PROVIDER_MAP = {
	"7cef8ef3-197d-49bf-9e67-2d92dbc5a313": "deepseek",
	"cffac5d0-f779-4552-84eb-814a2f869f35": "siliconflow",
	"003d5731-2309-452c-a873-b8066a536049": "tokenrhythm",
	"c94487f0-6c61-4437-b2f3-cd53049f8618": "opencode",
	"opencode-muse-mt1d67iz": "opencode-muse",
	"45715e7f-a2be-4ca7-9982-46c7665b5949": "cnooc",
	"88659594-a093-41d6-83c3-cdf90a5fdb66": "sensenova",
	"1ef5b450-5813-4b77-b6b2-10e5f53a0a29": "bigmodel",
	"bce62b1b-c52a-4d63-9308-96c2f1e1d01e": "zirocode",
	"5bcfcde7-647d-4ee3-8a63-79e2081e6c98": "huggingface",
	"ccb14685-081b-4756-8121-f941d8b997ae": "openrouter",
	"fdf82b56-a775-4281-ab22-39ef397c8bba": "nvidia",
	"2e42b7f4-38e1-4ab4-b65a-9b82bd6faf7d": "xiaoen-ai",
	"d02769aa-8775-4810-aecd-58b1b38964ec": "amd",
	"f58cebcd-3c66-48bc-857b-ed5790baffce": "orcarouter",
	"f4b23315-48fd-49f3-8ec1-8cfd9b1d45b7": "server-1432151545",
	"c97bf83a-0cde-4732-ad1d-5a8ae6e3163a": "bai",
	"6eda45fb-88b4-4a4c-9363-1fc2f0f57db5": "wechat-miniprogram",
	"6b3e253f-7d81-480b-8fbd-038361011ee6": "agentrouter",
	"e2f94756-fb31-4056-a58d-a23b0265d83e": "dots",
	"5275f50f-f960-45a4-a5f3-2cc9cbb26dab": "agnes",
	"b4ac94b1-4dd3-41a9-ba80-722399f3a645": "huihuiyun-1yuan",
	"12402cf5-c155-42b4-974d-89bac2d1fda2": "huihuiyun",
	"ee73d0e4-60b0-4a52-b0c7-61b0845f75c3": "scnet",
	"0050f37d-0b54-4ca5-8c9f-f05dcb3b44c9": "scnet-free",
};

function slugify(name) {
	if (!name) return "provider";
	const s = String(name).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	return s || "provider";
}

function dshKeyToEnv(dshKey) {
	return `${dshKey.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

function zcodeKindToApi(kind) {
	switch (kind) {
		case "anthropic":
			return "anthropic-messages";
		default:
			// openai 与 openai-compatible 都走 OpenAI 兼容协议
			return "openai-completions";
	}
}

/** ZCode variants 数组 → DSH reasoningEfforts 对象；空/缺省返回 undefined（继承 catalog 默认）。 */
function zcodeVariantsToDshEfforts(variants) {
	if (!Array.isArray(variants) || variants.length === 0) return undefined;
	const efforts = {};
	for (const v of variants) {
		const key = REASONING_KEY_MAP[v] ?? v;
		efforts[key] = REASONING_VALUE_MAP[v] !== undefined ? REASONING_VALUE_MAP[v] : v;
	}
	return efforts;
}

function deepEqualJson(a, b) {
	return JSON.stringify(a) === JSON.stringify(b);
}

function clone(value) {
	return value === undefined ? undefined : structuredClone(value);
}

/** 解析 ZCode config.json 路径（支持 ~ 与相对路径）。 */
function resolveZcodeConfigPath(configured) {
	const raw = configured && configured.trim();
	const p = !raw ? join(homedir(), ".zcode", "v2", "config.json") : isAbsolute(raw) ? raw : raw.startsWith("~") ? join(homedir(), raw.slice(1)) : resolve(process.cwd(), raw);
	return p;
}

/** 读当前 llm-pi-ai providers（describe 的 resolved value 是冻结的，这里给出可变副本）。 */
function readCurrentProviders(settings) {
	const descriptors = settings.describe();
	const pi = descriptors.find((d) => d.ns === "llm-pi-ai");
	if (!pi) return void 0;
	return clone(pi.value?.providers) ?? {};
}

/**
 * 把一个 ZCode 模型 upsert 进 DSH models 数组（按 id 匹配）。
 * 已有模型只更新 contextWindow/maxTokens/reasoningEfforts（与原脚本一致，
 * 不动 DSH 手工维护的 name/input）；缺失则追加完整条目。
 * @returns 是否发生了变化
 */
function upsertModel(models, modelId, zcodeModel) {
	let changed = false;
	let entry = models.find((m) => m && m.id === modelId);
	if (!entry) {
		entry = { id: modelId };
		if (zcodeModel.name) entry.name = zcodeModel.name;
		if (zcodeModel.limit?.context) entry.contextWindow = zcodeModel.limit.context;
		if (zcodeModel.limit?.output) entry.maxTokens = zcodeModel.limit.output;
		const input = zcodeModel.modalities?.input;
		if (Array.isArray(input) && input.length > 0) entry.input = input;
		// 注意：新增条目故意不写 reasoningEfforts —— 省略时继承 pi-ai catalog
		// 默认推理能力；显式写 off-only 会被 llm-pi-ai 拒绝（"offers no level beyond off"）。
		models.push(entry);
		return true;
	}
	if (zcodeModel.limit?.context !== undefined && entry.contextWindow !== zcodeModel.limit.context) {
		entry.contextWindow = zcodeModel.limit.context;
		changed = true;
	}
	if (zcodeModel.limit?.output !== undefined && entry.maxTokens !== zcodeModel.limit.output) {
		entry.maxTokens = zcodeModel.limit.output;
		changed = true;
	}
	if (zcodeModel.reasoning?.variants) {
		const efforts = zcodeVariantsToDshEfforts(zcodeModel.reasoning.variants);
		if (!deepEqualJson(efforts, entry.reasoningEfforts)) {
			entry.reasoningEfforts = efforts;
			changed = true;
		}
	}
	return changed;
}

/** 由 ZCode provider 构造全新 DSH provider 段。 */
function buildProviderSection(zcodeProvider, dshKey) {
	const section = {
		apiKeyEnv: dshKeyToEnv(dshKey),
		displayName: zcodeProvider.name || dshKey,
		api: zcodeKindToApi(zcodeProvider.kind),
	};
	if (zcodeProvider.options?.baseURL) section.baseURL = zcodeProvider.options.baseURL;
	section.models = [];
	return section;
}

async function writeCredential(credentials, envKey, apiKey, log) {
	try {
		const current = await credentials.resolve(envKey);
		if (current?.value === apiKey) return false;
		await credentials.write(envKey, apiKey);
		log(`凭据 ${envKey} 已写入凭据库`);
		return true;
	} catch (error) {
		log(`凭据 ${envKey} 写入失败（可能有只读层遮蔽该引用）：${error?.message ?? error}`);
		return false;
	}
}

export function apply(ctx, rawConfig) {
	// 文件打点：DSH 会接管进程 stdout/stderr，启动日志里看不到插件级输出，
	// 追加到 dsh 主目录的独立日志最可靠。
	const debugLog = join(homedir(), ".dsh", "zsync-plugin.log");
	const trace = (msg) => {
		try {
			appendFileSync(debugLog, `[${new Date().toISOString()}] ${msg}\n`);
		} catch {}
	};
	const settings = ctx.settings;
	const credentials = ctx.credentials;
	const log = (...parts) => {
		ctx.logger.info("[zcode-sync]", ...parts);
		trace(`INFO ${parts.join(" ")}`);
	};
	const warn = (...parts) => {
		ctx.logger.warn("[zcode-sync]", ...parts);
		trace(`WARN ${parts.join(" ")}`);
	};
	const fail = (...parts) => {
		ctx.logger.error("[zcode-sync]", ...parts);
		trace(`ERROR ${parts.join(" ")}`);
	};

	trace(`apply called; settings=${!!settings} credentials=${!!credentials}`);
	if (!settings) {
		fail("settings 服务不可用，插件无法工作");
		return;
	}

	let scope;
	try {
		scope = settings.register(`zcode-sync`, Config, { base: rawConfig });
		trace("namespace registered");
	} catch (error) {
		fail("注册 zcode-sync 设置命名空间失败：", error?.stack ?? error?.message ?? error);
		return;
	}

	let timer = null;
	let syncing = false;
	let rerunQueued = false;

	const schedule = (minutes) => {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		if (minutes > 0) timer = setInterval(() => void run("interval"), minutes * 60_000);
	};

	async function run(reason) {
		if (syncing) {
			rerunQueued = true;
			return;
		}
		syncing = true;
		try {
			const cfg = scope.get();
			if (!cfg.enabled) return;
			const report = await syncOnce(ctx, settings, credentials, cfg, log, warn, fail);
			log(
				`同步完成（${reason}）：新建 ${report.created}，更新 ${report.updated}，无变化 ${report.skipped}，失败 ${report.failed.length}，凭据写入 ${report.credentials}`,
				report.failed.length ? `失败明细: ${report.failed.join("; ")}` : "",
			);
		} catch (error) {
			fail(`同步异常（${reason}）：`, error?.stack ?? error?.message ?? error);
		} finally {
			syncing = false;
			if (rerunQueued) {
				rerunQueued = false;
				setTimeout(() => void run("rerun"), 1000);
			}
		}
	}

	scope.watch(() => {
		if (ctx.fiber?.uid === null) return;
		const cfg = scope.get();
		schedule(cfg.syncIntervalMinutes);
		void run("config-change");
	});

	schedule(scope.get().syncIntervalMinutes);

	if (scope.get().runOnStart && scope.get().enabled) {
		const delay = Math.max(0, scope.get().startDelayMs);
		ctx.effect(() => {
			const t = setTimeout(() => void run("startup"), delay);
			return () => clearTimeout(t);
		}, "zcode-sync.startup-run");
	}

	ctx.effect(() => () => {
		if (timer) clearInterval(timer);
	}, "zcode-sync.interval-cleanup");

	log(`插件已加载（dryRun=${scope.get().dryRun}，interval=${scope.get().syncIntervalMinutes}min）`);
}

/** 单次同步主体（独立函数便于测试与复用）。 */
export async function syncOnce(ctx, settings, credentials, cfg, log, warn, fail) {
	const report = { created: 0, updated: 0, skipped: 0, failed: [], credentials: 0 };

	const providerMap = { ...DEFAULT_PROVIDER_MAP, ...(cfg.extraProviderMap ?? {}) };

	// 1. 读 ZCode 配置
	const zcodePath = resolveZcodeConfigPath(cfg.zcodeConfigPath);
	if (!existsSync(zcodePath)) throw new Error(`ZCode config.json 不存在: ${zcodePath}`);
	let zcodeCfg;
	try {
		zcodeCfg = JSON.parse(readFileSync(zcodePath, "utf-8"));
	} catch (error) {
		throw new Error(`解析 ZCode config.json 失败: ${error.message}`);
	}

	// 2. 读 DSH 当前 llm-pi-ai providers；未注册说明自定义模型通道本身没起来
	const currentProviders = readCurrentProviders(settings);
	if (currentProviders === undefined) {
		throw new Error('settings 中没有 llm-pi-ai 命名空间——DSH 自定义模型通道未加载（检查 dsh-llm-pi-ai 补丁/版本），本次不写入');
	}

	// 3. 逐 provider 合并
	for (const [zcodeId, zcodeProvider] of Object.entries(zcodeCfg.provider ?? {})) {
		if (zcodeId.startsWith("builtin:")) continue;
		if (!zcodeProvider.models || Object.keys(zcodeProvider.models).length === 0) continue;

		const dshKey = providerMap[zcodeId] ?? slugify(zcodeProvider.name);
		const existing = currentProviders[dshKey];
		const created = !existing;

		try {
			const target = created ? buildProviderSection(zcodeProvider, dshKey) : clone(existing);

			// 既有段：补齐 ZCode 明确提供的连接信息（不覆盖 DSH 手工改动过的字段语义：
			// baseURL/api 仅在缺失时补，displayName 跟随 ZCode 名称变化）
			if (!created) {
				if (!target.apiKeyEnv) target.apiKeyEnv = dshKeyToEnv(dshKey);
				if (zcodeProvider.name && target.displayName !== zcodeProvider.name) target.displayName = zcodeProvider.name;
				if (!target.api) target.api = zcodeKindToApi(zcodeProvider.kind);
				if (!target.baseURL && zcodeProvider.options?.baseURL) target.baseURL = zcodeProvider.options.baseURL;
			}
			if (!Array.isArray(target.models)) target.models = [];

			// 3a. 凭据
			const apiKey = zcodeProvider.options?.apiKey;
			if (apiKey && credentials) {
				const wrote = await writeCredential(credentials, target.apiKeyEnv, String(apiKey), log);
				if (wrote) report.credentials += 1;
			} else if (apiKey && !credentials) {
				warn(`${dshKey}: 有 apiKey 但凭据服务不可用，跳过凭据写入`);
			}

			// 3b. 模型合并
			let modelsChanged = false;
			for (const [modelId, zcodeModel] of Object.entries(zcodeProvider.models)) {
				if (typeof zcodeModel !== "object" || zcodeModel === null) continue;
				if (upsertModel(target.models, modelId, zcodeModel)) modelsChanged = true;
			}

			// 3c. 写入（幂等：与现状一致则跳过）
			if (deepEqualJson(target, existing)) {
				report.skipped += 1;
				continue;
			}
			if (cfg.dryRun) {
				log(`[dryRun] ${dshKey}: ${created ? "新建" : "更新"}（models=${target.models.length}${modelsChanged ? ", 模型有变" : ""}）`);
				report.updated += 1;
				continue;
			}
			await settings.update("llm-pi-ai", { providers: { [dshKey]: target } });
			if (created) {
				report.created += 1;
				currentProviders[dshKey] = target;
				log(`已新建 provider ${dshKey}（${target.displayName ?? ""} api=${target.api} baseURL=${target.baseURL ?? "-"} models=${target.models.length}）`);
			} else {
				report.updated += 1;
				currentProviders[dshKey] = target;
				log(`已更新 provider ${dshKey}（models=${target.models.length}）`);
			}
		} catch (error) {
			// llm-pi-ai 校验拒绝（如重复模型 ID、off-only 推理档位等）会走到这里，
			// 单个 provider 失败不影响其余。
			report.failed.push(`${dshKey}: ${error?.message ?? error}`);
			fail(`provider ${dshKey} 同步被拒：`, error?.message ?? error);
		}
	}

	return report;
}
