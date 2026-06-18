import "./style.css";
import {
  ModelArkClient,
  ModelArkError,
  DEFAULT_BASE_URL,
  extractVideoUrl,
  type ContentItem,
  type VideoTask,
  type TaskStatus,
} from "./api.ts";

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

const LS = {
  apiKey: "seedance.apiKey",
  baseUrl: "seedance.baseUrl",
  model: "seedance.model",
};

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
};

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
        <label class="field grow">
          <span>Model ID</span>
          <input id="model" type="text" list="modelList" placeholder="seedance-2-0-pro-260615" />
          <datalist id="modelList">
            ${MODELS.map((m) => `<option value="${m.id}">${m.label}</option>`).join("")}
          </datalist>
        </label>
        <label class="field">
          <span>Aspect ratio</span>
          <select id="aspectRatio">
            <option value="16:9">16:9</option>
            <option value="9:16">9:16</option>
            <option value="1:1">1:1</option>
            <option value="4:3">4:3</option>
            <option value="3:4">3:4</option>
            <option value="21:9">21:9</option>
          </select>
        </label>
      </div>

      <div class="row">
        <label class="field">
          <span>Resolution</span>
          <select id="resolution">
            <option value="480p">480p</option>
            <option value="720p">720p</option>
            <option value="1080p" selected>1080p</option>
          </select>
        </label>
        <label class="field">
          <span>Duration (s)</span>
          <select id="duration">
            <option value="5" selected>5</option>
            <option value="10">10</option>
          </select>
        </label>
        <label class="field">
          <span>Seed</span>
          <input id="seed" type="number" placeholder="random" />
        </label>
      </div>

      <div class="row">
        <label class="field grow">
          <span>Image reference <em>(optional · image-to-video)</em> — paste a URL or upload a file</span>
          <div class="imgref">
            <input id="imageUrl" type="url" placeholder="https://…/first-frame.png" />
            <input id="imageFile" type="file" accept="image/png,image/jpeg,image/webp,image/bmp,image/tiff,image/gif,image/heic,image/heif" hidden />
            <button type="button" id="uploadBtn" class="ghost">⬆ Upload</button>
            <button type="button" id="clearImgBtn" class="ghost sm" title="Clear">✕</button>
          </div>
          <small id="imgHint" class="muted">Accepts URL or local image (sent as base64).</small>
        </label>
        <label class="field">
          <span>Ref role</span>
          <select id="imageRole">
            <option value="first_frame">first frame</option>
            <option value="last_frame">last frame</option>
            <option value="reference_image">reference</option>
          </select>
        </label>
      </div>

      <div class="row toggles">
        <label class="check"><input id="camerafixed" type="checkbox" /> Fixed camera</label>
        <label class="check"><input id="watermark" type="checkbox" /> Watermark</label>
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
        <button id="refreshTasksBtn" class="ghost sm">↻ Refresh</button>
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
      <p class="warn">The key is stored only in this browser's localStorage. For production, route requests through a backend.</p>
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

function updateConnStatus(): void {
  const el = $("#connStatus");
  const hasKey = !!(load(LS.apiKey, ENV_API_KEY));
  el.textContent = hasKey ? "ready" : "not configured";
  el.className = `badge ${hasKey ? "ok" : "idle"}`;
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
  keyInput.value = load(LS.apiKey, ENV_API_KEY);
  urlInput.value = load(LS.baseUrl, ENV_BASE_URL);

  keyInput.addEventListener("change", () => {
    save(LS.apiKey, keyInput.value.trim());
    updateConnStatus();
  });
  urlInput.addEventListener("change", () => {
    save(LS.baseUrl, urlInput.value.trim() || DEFAULT_BASE_URL);
  });
  dialog.addEventListener("close", () => {
    save(LS.apiKey, keyInput.value.trim());
    save(LS.baseUrl, urlInput.value.trim() || DEFAULT_BASE_URL);
    updateConnStatus();
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

function buildContent(): ContentItem[] {
  const content: ContentItem[] = [];
  const prompt = ($("#prompt") as HTMLTextAreaElement).value.trim();
  if (prompt) content.push({ type: "text", text: prompt });
  const img = ($("#imageUrl") as HTMLInputElement).value.trim();
  if (img) {
    content.push({
      type: "image_url",
      image_url: { url: img, role: ($("#imageRole") as HTMLSelectElement).value },
    });
  }
  return content;
}

async function generate(): Promise<void> {
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

function renderHistoryUpsert(stored: StoredTask): void {
  const idx = history.findIndex((t) => t.id === stored.id);
  if (idx >= 0) history[idx] = stored;
  else history.unshift(stored);
  renderHistory();
}

function renderHistory(): void {
  const list = $("#historyList");
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
}

/** Local image upload → base64 data URI (ModelArk accepts data: in image_url.url). */
function wireImageUpload(): void {
  const urlInput = $("#imageUrl") as HTMLInputElement;
  const fileInput = $("#imageFile") as HTMLInputElement;
  const hint = $("#imgHint");
  const pick = () => fileInput.click();

  $("#uploadBtn").addEventListener("click", pick);
  urlInput.addEventListener("dblclick", pick);

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    if (!/^image\//.test(file.type)) {
      toast("Please choose an image file.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      urlInput.value = String(reader.result);
      hint.textContent = `Loaded ${file.name} (${Math.round(file.size / 1024)} KB) as base64.`;
      toast("Image ready — sent as base64.");
    };
    reader.onerror = () => toast("Could not read the image file.");
    reader.readAsDataURL(file);
  });

  $("#clearImgBtn").addEventListener("click", () => {
    urlInput.value = "";
    fileInput.value = "";
    hint.textContent = "Accepts URL or local image (sent as base64).";
  });
}

function init(): void {
  renderApp();
  wireSettings();
  wireActions();
  updateConnStatus();
  renderHistory();
}

init();
