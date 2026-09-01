/*
 * Review Form Assistant - local answer server.
 *
 * Runs on your machine only. Binds to 127.0.0.1 so nothing on your network can
 * reach it. Holds the OpenAI API key in memory, read from the environment, and
 * never returns it, logs it, or exposes it to the extension.
 *
 * Node 20+. No third-party dependencies, so the whole dependency surface you
 * need to audit is this one file.
 *
 * Pure helpers are exported for the offline tests; the HTTP listener only starts
 * when this file is run directly.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const MAX_QUESTIONS = 15;
export const LOW_CONFIDENCE_THRESHOLD = 0.65;
/*
 * Providers. Both are OpenAI-shaped but not identical, so each one owns its own
 * URL, request body, and response reader. Adding another means adding an entry
 * here and an option in setup.html; nothing else changes.
 */
export const PROVIDERS = {
  openai: {
    id: "openai",
    label: "OpenAI",
    url: "https://api.openai.com/v1/responses",
    modelsUrl: "https://api.openai.com/v1/models",
    defaultModel: "gpt-4.1-mini",
    keyVar: "OPENAI_API_KEY",
    note: "Paid. Needs credits on the account.",
    /* Responses API with strict Structured Outputs: the schema is enforced. */
    buildBody: (questions, model) => ({
      model,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify({ questions }) }
      ],
      text: {
        format: { type: "json_schema", name: "review_answers", strict: true, schema: answerSchema() }
      }
    }),
    extractText: (payload) => extractOutputText(payload)
  },

  groq: {
    id: "groq",
    label: "Groq (free tier)",
    url: "https://api.groq.com/openai/v1/chat/completions",
    modelsUrl: "https://api.groq.com/openai/v1/models",
    defaultModel: "openai/gpt-oss-120b",
    keyVar: "GROQ_API_KEY",
    note: "Free tier, rate limited. Get a key at console.groq.com.",
    /*
     * Chat Completions with JSON mode. JSON mode guarantees valid JSON but not
     * the shape, so the schema is spelled out in the prompt and every field is
     * re-checked by normalizeAnswers afterwards. That validation was already
     * there, which is why this is safe without schema enforcement upstream.
     */
    buildBody: (questions, model) => ({
      model,
      messages: [
        { role: "system", content: `${SYSTEM_PROMPT}\n\n${JSON_SHAPE_INSTRUCTION}` },
        { role: "user", content: JSON.stringify({ questions }) }
      ],
      response_format: { type: "json_object" },
      temperature: 0
    }),
    extractText: (payload) => {
      const text = payload?.choices?.[0]?.message?.content;
      if (typeof text !== "string" || !text) throw new Error("Model response contained no text output.");
      return text;
    }
  }
};

export const DEFAULT_PROVIDER = "groq";

/** Look up a provider by id, falling back to the default rather than throwing. */
export const getProvider = (id) => PROVIDERS[String(id)] ?? PROVIDERS[DEFAULT_PROVIDER];

/* Kept for readability at call sites and in the tests. */
export const OPENAI_URL = PROVIDERS.openai.url;
export const DEFAULT_MODEL = PROVIDERS.openai.defaultModel;

/*
 * Models that cannot answer a multiple-choice question: speech, embeddings,
 * moderation, image and text-to-speech endpoints. Filtered out of the picker so
 * the list stays short and every entry is actually usable here.
 */
const EXCLUDED_MODEL =
  /whisper|tts|audio|embed|moderation|guard|orpheus|dall-e|image|transcribe|realtime|search|sora/i;

const MAX_BODY_BYTES = 256 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

const SYSTEM_PROMPT = [
  "You answer multiple-choice review questions.",
  "For every question you are given, choose exactly one option and return its",
  "zero-based index into the provided choices array.",
  "Give a confidence between 0 and 1 that reflects genuine uncertainty: use a",
  "value below 0.65 whenever the question is ambiguous, the choices overlap, or",
  "the material is outside what you can verify.",
  "Keep each explanation to one short sentence.",
  "Echo back the id of each question exactly as given."
].join(" ");

/*
 * Only needed by providers whose JSON mode does not enforce a schema. The shape
 * here must stay in step with answerSchema().
 */
const JSON_SHAPE_INSTRUCTION = [
  "Reply with a single JSON object and nothing else.",
  'It must have one key, "answers", holding an array with one entry per question.',
  'Each entry must be an object with exactly these keys: "id" (string, copied from the question),',
  '"index" (integer, zero-based position in that question\'s choices array),',
  '"confidence" (number between 0 and 1), and "explanation" (one short sentence).',
  "Do not add any other keys, and do not wrap the object in markdown fences."
].join(" ");

/* ------------------------------------------------------------------ *
 * Pure logic
 * ------------------------------------------------------------------ */

/**
 * Validate an incoming request body. Returns a new, sanitised question array.
 * Throws Error with a user-safe message on bad input.
 */
export const validateBatch = (payload) => {
  if (!payload || typeof payload !== "object") {
    throw new Error("Request body must be a JSON object.");
  }

  const { questions } = payload;
  if (!Array.isArray(questions)) {
    throw new Error("Request body must contain a 'questions' array.");
  }
  if (questions.length === 0) {
    throw new Error("No questions supplied.");
  }
  if (questions.length > MAX_QUESTIONS) {
    throw new Error(`Batch limit is ${MAX_QUESTIONS} questions; received ${questions.length}.`);
  }

  return questions.map((question, position) => {
    const id = typeof question?.id === "string" ? question.id : "";
    const text = typeof question?.text === "string" ? question.text : "";
    const choices = Array.isArray(question?.choices) ? question.choices : [];

    if (!id) throw new Error(`Question at position ${position} has no id.`);
    if (!text) throw new Error(`Question '${id}' has no text.`);
    if (choices.length < 2) throw new Error(`Question '${id}' has fewer than two choices.`);

    return {
      id,
      text,
      choices: choices.map((choice) => String(choice))
    };
  });
};

/** JSON schema handed to Structured Outputs. Strict mode: no extra properties. */
export const answerSchema = () => ({
  type: "object",
  additionalProperties: false,
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "index", "confidence", "explanation"],
        properties: {
          id: { type: "string" },
          index: { type: "integer" },
          confidence: { type: "number" },
          explanation: { type: "string" }
        }
      }
    }
  }
});

/** Build a request body for the given provider. Returns a new object. */
export const buildRequestBody = (questions, model, providerId = "openai") => {
  const provider = getProvider(providerId);
  return provider.buildBody(questions, model || provider.defaultModel);
};

/** Pull the JSON text out of a Responses API payload, tolerating shape drift. */
export const extractOutputText = (response) => {
  if (typeof response?.output_text === "string" && response.output_text) {
    return response.output_text;
  }

  const parts = Array.isArray(response?.output) ? response.output : [];
  for (const part of parts) {
    const content = Array.isArray(part?.content) ? part.content : [];
    for (const chunk of content) {
      if (typeof chunk?.text === "string" && chunk.text) return chunk.text;
    }
  }

  throw new Error("Model response contained no text output.");
};

/**
 * Clamp and filter model output against the questions we actually asked about.
 * Drops any answer whose id is unknown or whose index is out of range, so a
 * malformed response can never point the extension at an element we never saw.
 */
export const normalizeAnswers = (rawAnswers, questions) => {
  const byId = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set();
  const list = Array.isArray(rawAnswers) ? rawAnswers : [];

  return list.reduce((accumulator, answer) => {
    const id = typeof answer?.id === "string" ? answer.id : "";
    const question = byId.get(id);
    if (!question || seen.has(id)) return accumulator;

    const index = Number(answer?.index);
    if (!Number.isInteger(index) || index < 0 || index >= question.choices.length) {
      return accumulator;
    }

    const rawConfidence = Number(answer?.confidence);
    const confidence = Number.isFinite(rawConfidence)
      ? Math.min(1, Math.max(0, rawConfidence))
      : 0;

    const explanation = String(answer?.explanation ?? "").slice(0, 400);

    seen.add(id);
    return accumulator.concat({ id, index, confidence, explanation });
  }, []);
};

export const countLowConfidence = (answers, threshold = LOW_CONFIDENCE_THRESHOLD) =>
  answers.filter((answer) => answer.confidence < threshold).length;

/**
 * Turn an OpenAI error response into something a person can act on.
 *
 * Only the error 'type' and 'code' fields are read from the body. They come from
 * a fixed vocabulary, so nothing from the request itself can be echoed back into
 * a message the user sees. The raw body is never surfaced.
 */
export const describeApiError = (status, bodyText, model = DEFAULT_MODEL, provider = PROVIDERS.openai) => {
  let code = "";
  let type = "";

  try {
    const parsed = JSON.parse(String(bodyText ?? ""));
    code = String(parsed?.error?.code ?? "");
    type = String(parsed?.error?.type ?? "");
  } catch {
    // Non-JSON error body. Fall through to the status-only message.
  }

  const quotaExhausted =
    type === "insufficient_quota" ||
    code === "credit_balance_exhausted" ||
    code === "insufficient_quota";

  if (status === 401) {
    return `${provider.label} rejected the API key. Open http://127.0.0.1:8787/setup and enter it again.`;
  }
  if (status === 403) {
    return `${provider.label} refused this request for that key. Check the key's permissions.`;
  }
  if (status === 404 || code === "model_not_found" || code === "model_decommissioned") {
    return `${provider.label} does not recognise the model '${model}'. Pick another on the setup page.`;
  }
  if (status === 429 && quotaExhausted) {
    return `The ${provider.label} account has no credits left. Add credits, or switch provider on the setup page.`;
  }
  if (status === 429) {
    return `${provider.label} rate limit reached. Waiting and retrying automatically.`;
  }
  if (status >= 500) {
    return `${provider.label} is having trouble (HTTP ${status}). Try again shortly.`;
  }

  return `${provider.label} API returned HTTP ${status}.`;
};

/**
 * Ask the model. fetchImpl is injectable so tests run fully offline.
 * The API key is used here and nowhere else.
 */
/**
 * How long a provider asked us to wait, in seconds, or 0 when it did not say.
 * Reads the standard Retry-After header first, then the seconds quoted in the
 * error body, which is where Groq puts it.
 */
export const parseRetryAfter = (response, bodyText) => {
  const header = response?.headers?.get?.("retry-after");
  const fromHeader = Number(header);
  if (Number.isFinite(fromHeader) && fromHeader > 0) return Math.min(fromHeader, 120);

  const match = String(bodyText ?? "").match(/try again in\s+([\d.]+)\s*(m|s)/i);
  if (match) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      const seconds = match[2].toLowerCase() === "m" ? value * 60 : value;
      return Math.min(Math.ceil(seconds), 120);
    }
  }

  return 0;
};

/*
 * Models a provider is willing to serve this key./*
 * Models a provider is willing to serve this key. Used by the setup page so the
 * model field is a list of real options rather than a name to be guessed.
 * Providers retire models without warning; this is what keeps that from turning
 * into a mystery failure later.
 */
export const listModels = async (options = {}) => {
  const { apiKey, providerId = DEFAULT_PROVIDER, fetchImpl = globalThis.fetch } = options;
  const provider = getProvider(providerId);

  if (!apiKey) return [];

  let response;
  try {
    response = await fetchImpl(provider.modelsUrl, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
  } catch {
    return [];
  }

  if (!response.ok) return [];

  try {
    const payload = JSON.parse(await response.text());
    return (Array.isArray(payload?.data) ? payload.data : [])
      .map((entry) => String(entry?.id ?? ""))
      .filter(Boolean)
      .filter((id) => !EXCLUDED_MODEL.test(id))
      .sort();
  } catch {
    return [];
  }
};

export const requestAnswers = async (questions, options = {}) => {
  const { apiKey, providerId = DEFAULT_PROVIDER, fetchImpl = globalThis.fetch } = options;
  const provider = getProvider(providerId);
  const model = options.model || provider.defaultModel;

  if (!apiKey) {
    throw new Error(`No ${provider.label} API key is set on the server.`);
  }

  let response;
  try {
    response = await fetchImpl(provider.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(provider.buildBody(questions, model))
    });
  } catch (error) {
    // Never echo the original error: it can contain request headers.
    throw new Error(`Could not reach ${provider.label}. Check your network connection.`);
  }

  const text = await response.text();
  if (!response.ok) {
    const failure = new Error(describeApiError(response.status, text, model, provider));
    /* Rate limits and upstream hiccups are worth retrying; a bad key is not. */
    failure.retryable =
      (response.status === 429 || response.status >= 500) && !/no credits left/.test(failure.message);
    /* Providers say how long to wait. Guessing is worse than being told. */
    failure.retryAfterSeconds = parseRetryAfter(response, text);
    throw failure;
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`${provider.label} returned a non-JSON response.`);
  }

  /*
   * JSON-mode providers sometimes wrap the object in markdown fences despite
   * being told not to. Strip them before parsing rather than failing the batch.
   */
  const raw = provider.extractText(payload).trim().replace(/^```(?:json)?\s*|\s*```$/g, "");

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${provider.label} returned text that was not valid JSON.`);
  }

  return normalizeAnswers(parsed?.answers, questions);
};

/* ------------------------------------------------------------------ *
 * HTTP layer
 * ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SETUP_PAGE = path.join(HERE, "setup.html");
const ENV_FILE = path.join(HERE, ".env");

/**
 * Minimal .env reader. Enough for KEY=value lines with optional quotes and
 * # comments, which is all this project writes. Returns a new object; never
 * mutates process.env and never throws on a missing file.
 *
 * This exists so a key saved through the setup page survives a restart no
 * matter how the server was started.
 */
export const readEnvFile = (file) => {
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }

  return text.split("\n").reduce((accumulator, line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || line.trim().startsWith("#")) return accumulator;

    const value = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    return { ...accumulator, [match[1]]: value };
  }, {});
};

/**
 * Basic sanity check on a pasted key. Deliberately loose: OpenAI key formats
 * change, and rejecting a valid key is worse than letting the API reject a bad one.
 */
export const validateKey = (value) => {
  const key = String(value ?? "").trim();
  if (!key) throw new Error("Enter a key.");
  if (/\s/.test(key)) throw new Error("Key contains whitespace. Paste it again.");
  if (key.length < 20) throw new Error("That key looks too short.");
  if (key.length > 300) throw new Error("That key looks too long.");
  return key;
};

/**
 * Replace or append the given NAME=value entries in an .env body, preserving
 * every other line. Pure: takes the old text, returns new text.
 */
export const withEnv = (envText, entries) =>
  Object.entries(entries).reduce((text, [name, value]) => {
    const line = `${name}=${value}`;
    const lines = String(text ?? "").split("\n");
    const index = lines.findIndex((entry) => new RegExp(`^\\s*${name}\\s*=`).test(entry));

    if (index === -1) {
      return `${lines.filter((entry) => entry.trim() !== "").concat(line).join("\n")}\n`;
    }

    return lines
      .map((entry, position) => (position === index ? line : entry))
      .join("\n")
      .replace(/\n*$/, "\n");
  }, String(envText ?? ""));

/** Convenience wrapper for the common single-key case. */
export const withKey = (envText, key, name = "OPENAI_API_KEY") => withEnv(envText, { [name]: key });

/** Write entries to .env with owner-only permissions. Returns the path written. */
export const saveEnv = (entries, envFile = ENV_FILE) => {
  const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  fs.writeFileSync(envFile, withEnv(existing, entries), { mode: 0o600 });
  fs.chmodSync(envFile, 0o600);
  return envFile;
};

/** Back-compatible single-key save. */
export const saveKey = (key, envFile = ENV_FILE, name = "OPENAI_API_KEY") =>
  saveEnv({ [name]: key }, envFile);

/**
 * Who may talk to this server.
 * Loopback address is required in every case. An Origin header is accepted only
 * from an extension page or from this server's own setup page, so a website you
 * are visiting cannot reach the server through your browser, and cannot forge a
 * cross-site POST to /setup either.
 */
export const isAllowedRequest = (remoteAddress, origin) => {
  if (!LOOPBACK.has(String(remoteAddress))) return false;
  if (!origin) return true; // top-level navigation, or curl on this machine
  const value = String(origin);
  return value.startsWith("chrome-extension://") || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(value);
};

/** Reject Host headers that are not loopback, which blocks DNS rebinding. */
export const isAllowedHost = (host) =>
  !host || /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(String(host));

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

const corsHeaders = (origin) =>
  origin && String(origin).startsWith("chrome-extension://")
    ? {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS"
      }
    : {};

const sendJson = (res, status, body, origin) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...corsHeaders(origin)
  });
  res.end(JSON.stringify(body));
};

const sendPage = (res, html) => {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    /* The setup page loads nothing from anywhere. Pin that in a header too. */
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'"
  });
  res.end(html);
};

/**
 * Read provider settings out of the environment and .env, environment first.
 * Returns a new object; nothing is mutated.
 */
export const readSettings = (envFile = ENV_FILE) => {
  const file = readEnvFile(envFile);
  const pick = (name) => process.env[name] || file[name] || "";

  /*
   * An explicit PROVIDER wins. Failing that, prefer whichever provider already
   * has a key, so an existing setup is never silently switched out from under
   * the user. Only a genuinely empty install falls back to the default.
   */
  const explicit = pick("PROVIDER");
  const withKeys = Object.values(PROVIDERS).filter((provider) => pick(provider.keyVar));
  const providerId = PROVIDERS[explicit]
    ? explicit
    : (withKeys[0]?.id ?? DEFAULT_PROVIDER);

  return {
    providerId,
    model: pick("MODEL") || pick(`${providerId.toUpperCase()}_MODEL`) || getProvider(providerId).defaultModel,
    keys: Object.fromEntries(
      Object.values(PROVIDERS).map((provider) => [provider.id, pick(provider.keyVar)])
    )
  };
};

export const createServer = (options = {}) => {
  const {
    fetchImpl = globalThis.fetch,
    envFile = ENV_FILE,
    setupPage = SETUP_PAGE
  } = options;

  /*
   * The only mutable state. Replaced wholesale on every change, never mutated in
   * place, and no API key is ever included in a response body.
   */
  let state = readSettings(envFile);

  if (options.apiKey !== undefined || options.providerId || options.model) {
    const providerId = options.providerId ?? state.providerId;
    state = {
      providerId,
      model: options.model ?? getProvider(providerId).defaultModel,
      keys: { ...state.keys, [providerId]: options.apiKey ?? state.keys[providerId] }
    };
  }

  const currentProvider = () => getProvider(state.providerId);
  const currentKey = () => state.keys[state.providerId] || "";

  return http.createServer(async (req, res) => {
    const origin = req.headers.origin;

    if (!isAllowedHost(req.headers.host) || !isAllowedRequest(req.socket.remoteAddress, origin)) {
      sendJson(res, 403, { error: "Forbidden." }, null);
      return;
    }

    const url = String(req.url ?? "");

    if (req.method === "OPTIONS") {
      sendJson(res, 204, {}, origin);
      return;
    }

    /* Setup page. Served to a browser on this machine only. */
    if (req.method === "GET" && (url === "/" || url.startsWith("/setup"))) {
      try {
        sendPage(res, fs.readFileSync(setupPage, "utf8"));
      } catch {
        sendJson(res, 500, { error: "setup.html is missing from the project folder." }, origin);
      }
      return;
    }

    /* Status. Reports which providers have a key, never the keys themselves. */
    if (req.method === "GET" && url.startsWith("/health")) {
      sendJson(
        res,
        200,
        {
          ok: true,
          provider: state.providerId,
          providerLabel: currentProvider().label,
          model: state.model,
          maxQuestions: MAX_QUESTIONS,
          keyConfigured: Boolean(currentKey()),
          providers: Object.values(PROVIDERS).map((provider) => ({
            id: provider.id,
            label: provider.label,
            note: provider.note,
            defaultModel: provider.defaultModel,
            keyConfigured: Boolean(state.keys[provider.id])
          }))
        },
        origin
      );
      return;
    }

    /* Models this provider will serve for the stored key. */
    if (req.method === "GET" && url.startsWith("/models")) {
      const requested = new URL(url, "http://127.0.0.1").searchParams.get("provider");
      const providerId = requested && PROVIDERS[requested] ? requested : state.providerId;
      const models = await listModels({
        apiKey: state.keys[providerId],
        providerId,
        fetchImpl
      });

      sendJson(res, 200, { provider: providerId, models }, origin);
      return;
    }

    /* Save provider choice, key, and optional model from the setup page. */
    if (req.method === "POST" && url.startsWith("/setup")) {
      try {
        const body = JSON.parse(await readBody(req));
        const providerId = body?.provider ? getProvider(body.provider).id : state.providerId;

        if (body?.provider && !PROVIDERS[body.provider]) {
          throw new Error(`Unknown provider '${body.provider}'.`);
        }

        const provider = getProvider(providerId);
        const existingKey = state.keys[providerId];
        const hasNewKey = typeof body?.key === "string" && body.key.trim() !== "";

        if (!hasNewKey && !existingKey) {
          throw new Error(`Enter a ${provider.label} API key.`);
        }

        const key = hasNewKey ? validateKey(body.key) : existingKey;
        const model = typeof body?.model === "string" && body.model.trim()
          ? body.model.trim()
          : provider.defaultModel;

        const written = saveEnv(
          { PROVIDER: providerId, [provider.keyVar]: key, MODEL: model },
          envFile
        );

        state = { providerId, model, keys: { ...state.keys, [providerId]: key } };

        console.log(`[setup] provider set to ${provider.label}, model ${model}. Key written to .env.`);
        sendJson(res, 200, { ok: true, path: written, provider: providerId, model }, origin);
      } catch (error) {
        const message =
          error instanceof SyntaxError ? "Request body was not valid JSON." : error.message;
        console.error(`[setup] rejected: ${message}`);
        sendJson(res, 400, { error: message }, origin);
      }
      return;
    }

    if (req.method !== "POST" || !url.startsWith("/answer")) {
      sendJson(res, 404, { error: "Not found." }, origin);
      return;
    }

    try {
      if (!currentKey()) {
        throw new Error(
          `No ${currentProvider().label} API key configured. Open http://127.0.0.1:8787/setup and add one.`
        );
      }

      const raw = await readBody(req);
      const questions = validateBatch(JSON.parse(raw));
      const answers = await requestAnswers(questions, {
        apiKey: currentKey(),
        providerId: state.providerId,
        model: state.model,
        fetchImpl
      });

      // Counts only. Question and answer text are never logged.
      console.log(
        `[answer] ${questions.length} question(s) in, ${answers.length} answer(s) out, ` +
          `${countLowConfidence(answers)} below ${LOW_CONFIDENCE_THRESHOLD * 100}%.`
      );

      sendJson(res, 200, { answers }, origin);
    } catch (error) {
      const message =
        error instanceof SyntaxError ? "Request body was not valid JSON." : error.message;
      console.error(`[answer] rejected: ${message}`);
      sendJson(
        res,
        400,
        {
          error: message,
          retryable: Boolean(error.retryable),
          retryAfterSeconds: Number(error.retryAfterSeconds) || 0
        },
        origin
      );
    }
  });
};

/* Start listening only when this file is executed directly. */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const settings = readSettings();
  const provider = getProvider(settings.providerId);

  createServer().listen(port, "127.0.0.1", () => {
    console.log(`Review Form Assistant server listening on http://127.0.0.1:${port}`);
    console.log(`Setup and status page: http://127.0.0.1:${port}/setup`);
    console.log(`Provider: ${provider.label}. Model: ${settings.model}. Batch limit: ${MAX_QUESTIONS}.`);
    console.log(
      settings.keys[provider.id]
        ? "API key loaded."
        : `No ${provider.label} API key yet. Add one on the setup page above.`
    );
    console.log("Bound to loopback only. Press Ctrl+C to stop.");
  });
}
