import "./style.css";
import {
  ModelArkClient,
  ModelArkError,
  DEFAULT_BASE_URL,
  extractVideoUrl,
  type ContentItem,
  type VideoTask,
  type TaskStatus,
  type TaskUsage,
} from "./api.ts";
import {
  configureFal,
  planFalRequest,
  runFal,
  falEndpointLabel,
  type FalParams,
  type FalProvider,
} from "./fal.ts";

/**
 * SeeDance 2.0 video generation tool (BytePlus ModelArk).
 *
 * NOTE: The API key is stored only in this browser (localStorage) and used to
 * call ModelArk directly from the client. For production, proxy the requests
 * through a backend so the key never ships to end users.
 */

const ENV = import.meta.env;
const ENV_API_KEY = ENV.VITE_ARK_API_KEY ?? "";
const ENV_BASE_URL = ENV.VITE_ARK_BASE_URL ?? DEFAULT_BASE_URL;
const ENV_MODEL = ENV.VITE_ARK_MODEL ?? "";
const ENV_FAL_KEY = ENV.VITE_FAL_KEY ?? "";

const LS = {
  apiKey: "seedance.apiKey",
  baseUrl: "seedance.baseUrl",
  model: "seedance.model",
  pricePerMillion: "seedance.pricePerMillion",
  provider: "seedance.provider",
  falKey: "seedance.falKey",
  falModel: "seedance.falModel",
};

const PROVIDERS: { id: FalProvider; label: string }[] = [
  { id: "byteplus", label: "BytePlus ModelArk" },
  { id: "fal", label: "fal.ai" },
];

/** fal.ai models. Seedance 2.0 only for now; more can be added later. */
const FAL_MODELS: { id: string; label: string }[] = [
  { id: "seedance-2-0", label: "Seedance 2.0" },
];

/**
 * BytePlus ModelArk bills Seedance by token, not by second (see ModelArk
 * resource-pack pricing). Seedance 2.0 standard = $4.30 / 1M tokens,
 * Seedance 2.0 fast = $3.30 / 1M tokens. The rate is user-configurable below
 * since the API returns token usage per task but no currency amount.
 */
const DEFAULT_PRICE_PER_MILLION = 4.3;
const PRICE_PRESETS: { label: string; value: number }[] = [
  { label: "Seedance 2.0 · $4.30 / 1M", value: 4.3 },
  { label: "Seedance 2.0 fast · $3.30 / 1M", value: 3.3 },
];

const MODELS: { id: string; label: string }[] = [
  { id: "dreamina-seedance-2-0-260128", label: "Dreamina Seedance 2.0" },
  { id: "seedance-1-5-pro-251215", label: "Seedance 1.5 Pro" },
  { id: "seedance-1-0-pro-250528", label: "Seedance 1.0 Pro" },
];

type StoredTask = {
  id: string;
  status: TaskStatus;
  model: string;
  prompt: string;
  videoUrl?: string;
  createdAt: number;
  error?: string;
  tokens?: number;
  cost?: number;
};

function asNum(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Total billed tokens for a task (prefers total_tokens, falls back to parts). */
function extractTokens(task: VideoTask): number | undefined {
  const u = task.usage as TaskUsage | undefined;
  if (!u) return undefined;
  const total =
    asNum(u.total_tokens) ||
    asNum(u.prompt_tokens) + asNum(u.completion_tokens) ||
    asNum(u.completion_tokens);
  return total || undefined;
}

function getPricePerMillion(): number {
  const v = parseFloat(load(LS.pricePerMillion, String(DEFAULT_PRICE_PER_MILLION)));
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_PRICE_PER_MILLION;
}

function calcCost(tokens: number, perMillion: number): number {
  return (tokens / 1_000_000) * perMillion;
}

function fmtCost(cost: number): string {
  if (cost <= 0) return "$0.00";
  if (cost < 0.01) return "< $0.01";
  return `$${cost.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function load(key: string, fallback = ""): string {
  return localStorage.getItem(key) ?? fallback;
}
function save(key: string, value: string): void {
  localStorage.setItem(key, value);
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string,
  );
}

function $(sel: string): HTMLElement {
  return document.querySelector<HTMLElement>(sel)!;
}

function statusBadge(status: TaskStatus): string {
  const cls =
    status === "succeeded"
      ? "ok"
      : status === "failed" || status === "cancelled"
        ? "err"
        : "run";
  return `<span class="badge ${cls}">${escapeHtml(status)}</span>`;
}

function renderApp(): void {
  document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <header class="topbar">
    <div class="brand">
      <div class="logo">▶</div>
      <div>
        <h1>SeeDance&nbsp;2.0 Video Studio</h1>
        <p>AI video generation · BytePlus ModelArk</p>
      </div>
    </div>
    <div class="topbar-actions">
      <span id="connStatus" class="badge idle">not configured</span>
      <button id="settingsBtn" class="ghost" title="Settings">⚙ Settings</button>
    </div>
  </header>

  <main class="layout">
    <section class="panel composer">
      <h2>Generate</h2>

      <label class="field">
        <span>Prompt</span>
        <textarea id="prompt" rows="4" placeholder="Describe the scene… e.g. A cinematic drone shot over neon-lit Tokyo streets at night, rain reflections, 4k"></textarea>
      </label>

      <div class="row">
        <label class="field">
          <span>Provider</span>
          <select id="provider">
            ${PROVIDERS.map((p) => `<option value="${p.id}">${p.label}</option>`).join("")}
          </select>
        </label>
        <label class="field grow" id="modelBlock">
          <span>Model ID</span>
          <input id="model" type="text" list="modelList" placeholder="seedance-2-0-pro-260615" />
          <datalist id="modelList">
            ${MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("")}
          </datalist>
        </label>
        <label class="field grow" id="falModelBlock" hidden>
          <span>Model</span>
          <select id="falModel">
            ${FAL_MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("")}
          </select>
        </label>
      </div>

      <div class="row">
        <label class="field">
          <span>Resolution</span>
          <select id="resolution"></select>
        </label>
        <label class="field">
          <span>Duration</span>
          <select id="duration"></select>
        </label>
        <label class="field">
          <span>Aspect ratio</span>
          <select id="aspectRatio"></select>
        </label>
      </div>

      <div class="row" id="byteplusOpts">
        <label class="field">
          <span>Seed</span>
          <input id="seed" type="number" placeholder="random" />
        </label>
        <label class="check"><input id="camerafixed" type="checkbox" /> Fixed camera</label>
        <label class="check"><input id="watermark" type="checkbox" /> Watermark</label>
      </div>

      <div class="row" id="falOpts" hidden>
        <label class="field">
          <span>Bitrate mode</span>
          <select id="bitrateMode">
            <option value="standard">standard</option>
            <option value="high">high</option>
          </select>
        </label>
        <label class="check"><input id="generateAudio" type="checkbox" checked /> Generate audio</label>
      </div>

      <div class="row">
        <div class="field grow" style="flex-basis: 100%;">
          <span>Reference images <em>(optional · drives text / image / reference-to-video)</em></span>
          <div class="imgref">
            <input id="imageUrl" type="url" placeholder="Paste image URL, then click Add…" />
            <button type="button" id="addUrlBtn" class="ghost">＋ Add</button>
            <input id="imageFile" type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/tiff,image/gif,image/heic,image/heif" multiple hidden />
            <button type="button" id="uploadBtn" class="ghost">⬆ Upload</button>
          </div>
          <small id="imgHint" class="muted">No reference images yet. Add via URL or upload (multiple supported).</small>
          <div id="imgList" class="imglist"></div>
        </div>
      </div>

      <div class="row actions">
        <button id="generateBtn" class="primary">Generate video</button>
        <button id="surpriseBtn" class="ghost">🎲 Surprise me</button>
        <span id="genStatus" class="hint"></span>
      </div>
    </section>

    <section class="panel result">
      <h2>Result</h2>
      <div id="resultArea" class="result-area">
        <div class="placeholder">Your generated video will appear here.</div>
      </div>
    </section>

    <section class="panel history">
      <div class="history-head">
        <h2>Tasks</h2>
        <div class="history-head-actions">
          <span id="totalCost" class="cost-total" title="Estimated total cost of listed tasks (tokens × price)">≈ —</span>
          <button id="refreshTasksBtn" class="ghost sm">↻ Refresh</button>
        </div>
      </div>
      <div id="historyList" class="history-list"></div>
    </section>
  </main>

  <dialog id="settingsDialog" class="settings">
    <form method="dialog">
      <h3>Settings</h3>
      <label class="field">
        <span>API key <em>(Bearer token)</em></span>
        <input id="apiKeyInput" type="password" placeholder="ark-…" autocomplete="off" />
      </label>
      <label class="field">
        <span>Base URL</span>
        <input id="baseUrlInput" type="url" />
      </label>
      <label class="field">
        <span>Cost estimate — price / 1M tokens (USD) <em>(Seedance is billed per token)</em></span>
        <input id="priceInput" type="number" min="0" step="0.01" />
      </label>
      <div class="presets" id="pricePresets"></div>
      <p class="muted small">Cost is estimated from each task's token usage × this rate (BytePlus ModelArk resource-pack pricing: Seedance 2.0 = $4.30/M, fast = $3.30/M). The API returns token counts, not a currency amount.</p>

      <hr class="sep" />
      <h4 class="settings-h4">fal.ai</h4>
      <label class="field">
        <span>fal.ai API key <em>(for Seedance 2.0 via fal.ai)</em></span>
        <input id="falKeyInput" type="password" placeholder="fal-… or UUID:UUID" autocomplete="off" />
      </label>
      <p class="muted small">Used when Provider = fal.ai. Set <code>VITE_FAL_KEY</code> to ship a default key with the build.</p>
      <p class="warn">Keys are stored only in this browser's localStorage and called client-side. For production, route requests through a backend so keys never ship to end users.</p>
      <div class="row actions">
        <button type="button" id="clearKeyBtn" class="ghost">Clear key</button>
        <button type="submit" class="primary">Save</button>
      </div>
    </form>
  </dialog>

  <div id="toast" class="toast"></div>
  `;
}

let currentAbort: AbortController | null = null;

function getClient(): ModelArkClient | null {
  const apiKey = load(LS.apiKey, ENV_API_KEY);
  if (!apiKey) {
    toast("Add your ModelArk API key in Settings ⚙");
    openSettings();
    return null;
  }
  return new ModelArkClient({
    apiKey,
    baseUrl: load(LS.baseUrl, ENV_BASE_URL),
  });
}

const PROVIDER_OPTS: Record<
  FalProvider,
  { resolution: readonly string[]; duration: readonly string[]; aspect: readonly string[] }
> = {
  byteplus: {
    resolution: ["480p", "720p", "1080p"],
    duration: ["5", "10"],
    aspect: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
  },
  fal: {
    resolution: ["480p", "720p", "1080p", "4k"],
    duration: ["auto", "4", "5", "6", "7", "8", "9", "10", "11", "12", "13", "14", "15"],
    aspect: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
  },
};

function getProvider(): FalProvider {
  return load(LS.provider, "byteplus") === "fal" ? "fal" : "byteplus";
}

function setSelectOptions(sel: HTMLSelectElement, options: readonly string[]): void {
  const prev = sel.value;
  sel.innerHTML = options.map((o) => `<option value="${o}">${o}</option>`).join("");
  if (options.includes(prev)) sel.value = prev;
}

/** Toggle model fields + per-provider option rows + repopulate shared selects. */
function applyProvider(provider: FalProvider): void {
  const isFal = provider === "fal";
  ($("#provider") as HTMLSelectElement).value = provider;
  ($("#modelBlock") as HTMLElement).hidden = isFal;
  ($("#falModelBlock") as HTMLElement).hidden = !isFal;
  ($("#byteplusOpts") as HTMLElement).hidden = isFal;
  ($("#falOpts") as HTMLElement).hidden = !isFal;

  const opts = PROVIDER_OPTS[provider];
  setSelectOptions($("#resolution") as HTMLSelectElement, opts.resolution);
  setSelectOptions($("#duration") as HTMLSelectElement, opts.duration);
  setSelectOptions($("#aspectRatio") as HTMLSelectElement, opts.aspect);

  updateConnStatus();
}

function updateConnStatus(): void {
  const el = $("#connStatus");
  const ready =
    getProvider() === "fal"
      ? !!(load(LS.falKey, ENV_FAL_KEY))
      : !!(load(LS.apiKey, ENV_API_KEY));
  el.textContent = ready ? "ready" : "not configured";
  el.className = `badge ${ready ? "ok" : "idle"}`;
}

function toast(msg: string): void {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout((toast as unknown as { _t?: number })._t);
  (toast as unknown as { _t?: number })._t = window.setTimeout(
    () => el.classList.remove("show"),
    3200,
  );
}

function openSettings(): void {
  ($("#settingsDialog") as HTMLDialogElement).showModal();
}

function wireSettings(): void {
  const dialog = $("#settingsDialog") as HTMLDialogElement;
  $("#settingsBtn").addEventListener("click", () => dialog.showModal());

  const keyInput = $("#apiKeyInput") as HTMLInputElement;
  const urlInput = $("#baseUrlInput") as HTMLInputElement;
  const priceInput = $("#priceInput") as HTMLInputElement;
  const falKeyInput = $("#falKeyInput") as HTMLInputElement;
  keyInput.value = load(LS.apiKey, ENV_API_KEY);
  urlInput.value = load(LS.baseUrl, ENV_BASE_URL);
  priceInput.value = String(getPricePerMillion());
  falKeyInput.value = load(LS.falKey, ENV_FAL_KEY);

  const presetsEl = $("#pricePresets");
  presetsEl.innerHTML = PRICE_PRESETS.map(
    (p) => `<button type="button" class="ghost sm" data-price="${p.value}">${escapeHtml(p.label)}</button>`,
  ).join("");
  const savePrice = () => {
    const v = parseFloat(priceInput.value);
    save(LS.pricePerMillion, String(Number.isFinite(v) && v >= 0 ? v : DEFAULT_PRICE_PER_MILLION));
  };
  presetsEl.querySelectorAll<HTMLButtonElement>("button[data-price]").forEach((btn) => {
    btn.addEventListener("click", () => {
      priceInput.value = btn.dataset.price ?? "";
      savePrice();
    });
  });

  priceInput.addEventListener("change", savePrice);

  keyInput.addEventListener("change", () => {
    save(LS.apiKey, keyInput.value.trim());
    updateConnStatus();
  });
  urlInput.addEventListener("change", () => {
    save(LS.baseUrl, urlInput.value.trim() || DEFAULT_BASE_URL);
  });
  falKeyInput.addEventListener("change", () => {
    save(LS.falKey, falKeyInput.value.trim());
    updateConnStatus();
  });
  dialog.addEventListener("close", () => {
    save(LS.apiKey, keyInput.value.trim());
    save(LS.baseUrl, urlInput.value.trim() || DEFAULT_BASE_URL);
    save(LS.falKey, falKeyInput.value.trim());
    savePrice();
    updateConnStatus();
    recalcAllCosts();
  });
  $("#clearKeyBtn").addEventListener("click", () => {
    keyInput.value = "";
    save(LS.apiKey, "");
    updateConnStatus();
    toast("API key cleared");
  });
}

/**
 * Build generation parameters. ModelArk expects these at the TOP LEVEL of the
 * request body (not nested). Field names follow the Seedance 2.0 API:
 * resolution, ratio, duration, seed, camera_fixed, watermark.
 */
function buildParameters(): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const resolution = ($("#resolution") as HTMLSelectElement).value;
  const ratio = ($("#aspectRatio") as HTMLSelectElement).value;
  const duration = parseInt(($("#duration") as HTMLSelectElement).value, 10);
  const seedRaw = ($("#seed") as HTMLInputElement).value.trim();
  const cameraFixed = ($("#camerafixed") as HTMLInputElement).checked;
  const watermark = ($("#watermark") as HTMLInputElement).checked;

  if (resolution) params.resolution = resolution;
  if (ratio) params.ratio = ratio;
  if (duration) params.duration = duration;
  if (seedRaw) params.seed = parseInt(seedRaw, 10);
  params.camera_fixed = cameraFixed;
  params.watermark = watermark;
  return params;
}

type RefImage = { url: string; role: string; name?: string };
const refImages: RefImage[] = [];

function buildContent(): ContentItem[] {
  const content: ContentItem[] = [];
  const prompt = ($("#prompt") as HTMLTextAreaElement).value.trim();
  if (prompt) content.push({ type: "text", text: prompt });
  for (const img of refImages) {
    content.push({
      type: "image_url",
      image_url: { url: img.url },
      role: img.role,
    });
  }
  return content;
}

function buildFalParams(): FalParams {
  return {
    resolution: ($("#resolution") as HTMLSelectElement).value,
    duration: ($("#duration") as HTMLSelectElement).value,
    aspect_ratio: ($("#aspectRatio") as HTMLSelectElement).value,
    generate_audio: ($("#generateAudio") as HTMLInputElement).checked,
    bitrate_mode: ($("#bitrateMode") as HTMLSelectElement).value as "standard" | "high",
  };
}

async function generate(): Promise<void> {
  if (getProvider() === "fal") return generateFal();
  return generateByteplus();
}

async function generateByteplus(): Promise<void> {
  const client = getClient();
  if (!client) return;

  const model = ($("#model") as HTMLInputElement).value.trim();
  const content = buildContent();
  if (!model) {
    toast("Please enter a Model ID.");
    return;
  }
  if (!content.some((c) => c.type === "text")) {
    toast("Please enter a prompt.");
    return;
  }

  const btn = $("#generateBtn") as HTMLButtonElement;
  btn.disabled = true;
  const status = $("#genStatus");
  status.textContent = "Submitting task…";
  setResultPlaceholder("Submitting task…");

  try {
    const task = await client.createVideoTask({
      model,
      content,
      ...buildParameters(),
    });
    save(LS.model, model);
    currentAbort?.abort();
    currentAbort = new AbortController();

    const stored: StoredTask = {
      id: task.id,
      status: task.status,
      model,
      prompt: content.find((c) => c.type === "text")?.text ?? "",
      createdAt: Date.now(),
    };
    await pollAndRender(client, stored, currentAbort.signal);
  } catch (e) {
    handleError(e);
  } finally {
    btn.disabled = false;
    status.textContent = "";
  }
}

async function generateFal(): Promise<void> {
  const key = load(LS.falKey, ENV_FAL_KEY);
  if (!key) {
    toast("Add your fal.ai API key in Settings ⚙");
    openSettings();
    return;
  }
  configureFal(key);

  const prompt = ($("#prompt") as HTMLTextAreaElement).value.trim();
  if (!prompt) {
    toast("Please enter a prompt.");
    return;
  }

  const plan = planFalRequest(prompt, refImages, buildFalParams());
  const label = falEndpointLabel(plan.endpoint);
  const btn = $("#generateBtn") as HTMLButtonElement;
  btn.disabled = true;
  const status = $("#genStatus");
  status.textContent = `fal.ai · ${label}: submitting…`;
  setResultPlaceholder(`fal.ai · ${label} — submitting…`);

  const stored: StoredTask = {
    id: `fal-${Date.now()}`,
    status: "queued",
    model: `Seedance 2.0 · fal.ai (${label})`,
    prompt,
    createdAt: Date.now(),
  };
  renderHistoryUpsert(stored);

  try {
    const res = await runFal(plan, {
      onStatus: (s) => {
        const running = s !== "COMPLETED" && s !== "FAILED";
        stored.status = running ? "running" : "succeeded";
        status.textContent = `fal.ai: ${s || "working"}…`;
        if (running) setProgress("running");
        renderHistoryUpsert(stored);
      },
    });
    stored.id = res.requestId;
    stored.status = "succeeded";
    stored.videoUrl = res.videoUrl;
    renderVideo(res.videoUrl, stored);
    toast("fal.ai video ready");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stored.status = "failed";
    stored.error = msg;
    renderError(msg);
  } finally {
    renderHistoryUpsert(stored);
    btn.disabled = false;
    status.textContent = "";
  }
}

async function pollAndRender(
  client: ModelArkClient,
  stored: StoredTask,
  signal: AbortSignal,
): Promise<void> {
  const status = $("#genStatus");
  const onProgress = (t: VideoTask) => {
    stored.status = t.status;
    stored.model = t.model ?? stored.model;
    status.textContent = `Task ${t.id}: ${t.status}…`;
    setProgress(t.status);
    renderHistoryUpsert(stored);
  };

  try {
    const final = await client.pollTask(stored.id, {
      intervalMs: 3500,
      timeoutMs: 10 * 60 * 1000,
      signal,
      onUpdate: onProgress,
    });
    stored.status = final.status;
    const toks = extractTokens(final);
    if (toks != null) {
      stored.tokens = toks;
      stored.cost = calcCost(toks, getPricePerMillion());
    }
    if (final.status === "succeeded") {
      const url = extractVideoUrl(final);
      stored.videoUrl = url;
      if (url) renderVideo(url, stored);
      else setResultPlaceholder("Completed but no video URL returned.");
    } else {
      stored.error =
        (final.error as { message?: string } | undefined)?.message ??
        `Task ended with status ${final.status}`;
      renderError(stored.error);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    stored.status = "failed";
    stored.error = msg;
    renderError(msg);
  } finally {
    renderHistoryUpsert(stored);
    status.textContent = "";
  }
}

function setProgress(status: TaskStatus): void {
  const area = $("#resultArea");
  if (status === "queued" || status === "running") {
    area.innerHTML = `<div class="placeholder"><div class="spinner"></div>Generating… (${status})</div>`;
  }
}

function renderVideo(url: string, stored: StoredTask): void {
  $("#resultArea").innerHTML = `
    <video src="${escapeHtml(url)}" controls autoplay loop playsinline class="video"></video>
    <div class="result-meta">
      <span>${statusBadge(stored.status)}</span>
      <span class="muted">${escapeHtml(stored.model)}</span>
      ${stored.tokens ? `<span class="muted">${fmtTokens(stored.tokens)} tokens</span>` : ""}
      ${stored.cost != null ? `<span class="badge cost">≈ ${fmtCost(stored.cost)}</span>` : ""}
      <a class="ghost sm" href="${escapeHtml(url)}" download target="_blank" rel="noopener">⬇ Download</a>
      <button class="ghost sm" id="copyUrlBtn" data-url="${escapeHtml(url)}">⧉ Copy URL</button>
    </div>`;
  $("#copyUrlBtn").addEventListener("click", () => {
    navigator.clipboard.writeText(url).then(() => toast("Video URL copied"));
  });
}

function renderError(msg: string): void {
  $("#resultArea").innerHTML = `<div class="placeholder err">❌ ${escapeHtml(msg)}</div>`;
}

function setResultPlaceholder(msg: string): void {
  $("#resultArea").innerHTML = `<div class="placeholder">${escapeHtml(msg)}</div>`;
}

const history: StoredTask[] = [];

/** Recompute every task's cost against the current price (e.g. after rate edit). */
function recalcAllCosts(): void {
  const rate = getPricePerMillion();
  let changed = false;
  for (const t of history) {
    if (t.tokens != null) {
      const c = calcCost(t.tokens, rate);
      if (t.cost !== c) {
        t.cost = c;
        changed = true;
      }
    }
  }
  if (changed) renderHistory();
}

function renderHistoryUpsert(stored: StoredTask): void {
  const idx = history.findIndex((t) => t.id === stored.id);
  if (idx >= 0) history[idx] = stored;
  else history.unshift(stored);
  renderHistory();
}

function renderHistory(): void {
  const list = $("#historyList");
  const total = history.reduce((s, t) => s + (t.cost ?? 0), 0);
  const counted = history.filter((t) => t.cost != null).length;
  const totalEl = $("#totalCost");
  if (totalEl) {
    totalEl.textContent = counted
      ? `≈ ${fmtCost(total)} (${counted} task${counted === 1 ? "" : "s"})`
      : "≈ —";
  }
  if (!history.length) {
    list.innerHTML = `<div class="placeholder sm">No tasks yet.</div>`;
    return;
  }
  list.innerHTML = history
    .map(
      (t) => `
      <div class="task" data-id="${escapeHtml(t.id)}">
        <div class="task-top">
          ${statusBadge(t.status)}
          <span class="muted">${escapeHtml(t.model)}</span>
          ${t.tokens ? `<span class="muted">${fmtTokens(t.tokens)} tok</span>` : ""}
          ${t.cost != null ? `<span class="badge cost">≈ ${fmtCost(t.cost)}</span>` : ""}
          <span class="muted mono">${escapeHtml(t.id)}</span>
        </div>
        <div class="task-prompt">${escapeHtml(t.prompt || "(no prompt)")}</div>
        <div class="task-actions">
          <button class="ghost sm" data-act="refresh">↻</button>
          ${t.videoUrl ? `<a class="ghost sm" href="${escapeHtml(t.videoUrl)}" target="_blank" rel="noopener">view</a>` : ""}
          <button class="ghost sm" data-act="remove">✕</button>
        </div>
      </div>`,
    )
    .join("");

  list.querySelectorAll<HTMLElement>(".task").forEach((node) => {
    const id = node.dataset.id!;
    node.querySelector<HTMLButtonElement>('[data-act="refresh"]')?.addEventListener("click", () => refreshTask(id));
    node.querySelector<HTMLButtonElement>('[data-act="remove"]')?.addEventListener("click", () => {
      const i = history.findIndex((t) => t.id === id);
      if (i >= 0) history.splice(i, 1);
      renderHistory();
    });
  });
}

async function refreshTask(id: string): Promise<void> {
  const client = getClient();
  if (!client) return;
  const t = history.find((x) => x.id === id);
  if (!t) return;
  try {
    const task = await client.getVideoTask(id);
    t.status = task.status;
    const toks = extractTokens(task);
    if (toks != null) {
      t.tokens = toks;
      t.cost = calcCost(toks, getPricePerMillion());
    }
    if (task.status === "succeeded") t.videoUrl = extractVideoUrl(task);
    if (task.status === "failed")
      t.error = (task.error as { message?: string } | undefined)?.message;
    renderHistory();
    if (t.videoUrl && !$("#resultArea video")) renderVideo(t.videoUrl, t);
  } catch (e) {
    handleError(e);
  }
}

async function loadRemoteTasks(): Promise<void> {
  const client = getClient();
  if (!client) return;
  try {
    const res = await client.listVideoTasks({ limit: 20 });
    for (const t of res.data ?? []) {
      const stored: StoredTask = {
        id: t.id,
        status: t.status,
        model: t.model,
        prompt:
          (t as { content?: { text?: string } }).content?.text ??
          "(imported task)",
        createdAt: t.created_at ? t.created_at * 1000 : Date.now(),
        videoUrl: extractVideoUrl(t),
      };
      const toks = extractTokens(t);
      if (toks != null) {
        stored.tokens = toks;
        stored.cost = calcCost(toks, getPricePerMillion());
      }
      const idx = history.findIndex((x) => x.id === stored.id);
      if (idx >= 0) history[idx] = stored;
      else history.push(stored);
    }
    history.sort((a, b) => b.createdAt - a.createdAt);
    renderHistory();
    toast(`Loaded ${res.data?.length ?? 0} tasks`);
  } catch (e) {
    handleError(e);
  }
}

function handleError(e: unknown): void {
  if (e instanceof ModelArkError) {
    toast(`Error ${e.status}: ${e.message}`);
    renderError(`${e.message} (HTTP ${e.status})`);
  } else if (e instanceof Error) {
    toast(e.message);
    renderError(e.message);
  } else {
    toast("Unknown error");
  }
}

const SURPRISES = [
  "A lone astronaut walking across a desert of glowing blue crystals under a double sunset, cinematic, volumetric light",
  "Macro shot of dew drops sliding down a spider web at golden hour, hyper-detailed, slow motion",
  "A neon cyberpunk car drifting through a rainy Shanghai alley, reflections, cinematic, 4k",
  "Time-lapse of a flower blooming on a moss-covered ancient statue in a misty jungle",
  "A paper boat sailing down a glowing river of stars in a dreamlike sky",
];

function wireActions(): void {
  $("#generateBtn").addEventListener("click", generate);
  $("#surpriseBtn").addEventListener("click", () => {
    const p = SURPRISES[Math.floor(Math.random() * SURPRISES.length)];
    ($("#prompt") as HTMLTextAreaElement).value = p;
  });
  $("#refreshTasksBtn").addEventListener("click", loadRemoteTasks);
  wireImageUpload();

  ($("#model") as HTMLInputElement).value = load(
    LS.model,
    ENV_MODEL || MODELS[0].id,
  );
  ($("#falModel") as HTMLSelectElement).value = load(LS.falModel, FAL_MODELS[0].id);
  ($("#falModel") as HTMLSelectElement).addEventListener("change", (e) => {
    save(LS.falModel, (e.target as HTMLSelectElement).value);
  });

  const providerSel = $("#provider") as HTMLSelectElement;
  providerSel.value = getProvider();
  providerSel.addEventListener("change", (e) => {
    const provider = (e.target as HTMLSelectElement).value as FalProvider;
    save(LS.provider, provider);
    applyProvider(provider);
  });
  applyProvider(getProvider());
}

/** Render the list of attached reference images (each with its own role + remove). */
function renderImgList(): void {
  const list = $("#imgList");
  const hint = $("#imgHint");
  if (!refImages.length) {
    list.innerHTML = "";
    hint.textContent = "No reference images yet. Add via URL or upload (multiple supported).";
    return;
  }
  hint.textContent = `${refImages.length} reference image${refImages.length > 1 ? "s" : ""} attached.`;
  list.innerHTML = refImages
    .map(
      (img, idx) => `
      <div class="imgcard" data-idx="${idx}" title="${escapeHtml(img.name || img.url)}">
        <img src="${escapeHtml(img.url)}" alt="reference" />
        <div class="imgcard-fields">
          <select class="img-role" aria-label="Reference role">
            <option value="first_frame"${img.role === "first_frame" ? " selected" : ""}>first frame</option>
            <option value="last_frame"${img.role === "last_frame" ? " selected" : ""}>last frame</option>
            <option value="reference_image"${img.role === "reference_image" ? " selected" : ""}>reference</option>
          </select>
          <button type="button" class="ghost sm" data-act="remove" title="Remove">✕</button>
        </div>
      </div>`,
    )
    .join("");

  list.querySelectorAll<HTMLElement>(".imgcard").forEach((node) => {
    const idx = Number(node.dataset.idx);
    node.querySelector<HTMLSelectElement>(".img-role")?.addEventListener("change", (e) => {
      refImages[idx].role = (e.target as HTMLSelectElement).value;
    });
    node.querySelector<HTMLButtonElement>('[data-act="remove"]')?.addEventListener("click", () => {
      refImages.splice(idx, 1);
      renderImgList();
    });
  });
}

/** Multi-image references: add via URL or upload (multiple files), each with its own role. */
function wireImageUpload(): void {
  const urlInput = $("#imageUrl") as HTMLInputElement;
  const fileInput = $("#imageFile") as HTMLInputElement;

  const addUrl = () => {
    const url = urlInput.value.trim();
    if (!url) return;
    refImages.push({ url, role: "reference_image" });
    urlInput.value = "";
    renderImgList();
    toast(`Reference image added (${refImages.length} total).`);
  };

  $("#addUrlBtn").addEventListener("click", addUrl);
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addUrl();
    }
  });

  $("#uploadBtn").addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []);
    if (!files.length) return;
    let pending = files.length;
    const finish = () => {
      renderImgList();
      fileInput.value = "";
      toast(`${refImages.length} reference image${refImages.length > 1 ? "s" : ""} attached.`);
    };
    files.forEach((file) => {
      if (!/^image\//.test(file.type)) {
        toast(`${file.name} is not an image; skipped.`);
        pending--;
        if (pending === 0) finish();
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        refImages.push({ url: String(reader.result), role: "reference_image", name: file.name });
        pending--;
        if (pending === 0) finish();
      };
      reader.onerror = () => {
        toast(`Could not read ${file.name}.`);
        pending--;
        if (pending === 0) finish();
      };
      reader.readAsDataURL(file);
    });
  });

  renderImgList();
}

function init(): void {
  renderApp();
  wireSettings();
  wireActions();
  updateConnStatus();
  renderHistory();
}

init();
