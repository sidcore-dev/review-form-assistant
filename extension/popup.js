/*
 * Review Form Assistant - popup script.
 *
 * The popup is the only component that talks to the network. It reaches exactly
 * one endpoint, http://127.0.0.1:8787/answer, which is the sole host permission
 * in the manifest. It never sees or handles the OpenAI API key; the local server
 * owns that.
 */

"use strict";

const SERVER_ORIGIN = "http://127.0.0.1:8787";
const SERVER_URL = `${SERVER_ORIGIN}/answer`;
const HEALTH_URL = `${SERVER_ORIGIN}/health`;
const SETUP_URL = `${SERVER_ORIGIN}/setup`;
const LOW_CONFIDENCE_THRESHOLD = 0.65;
const MAX_QUESTIONS_PER_BATCH = 15;
const REQUEST_TIMEOUT_MS = 60000;
const RETRY_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 5000;
const BETWEEN_BATCH_MS = 1200;

const els = {
  confirm: document.getElementById("confirm"),
  answer: document.getElementById("answer"),
  clear: document.getElementById("clear"),
  status: document.getElementById("status"),
  setup: document.getElementById("setup"),
  dot: document.getElementById("dot"),
  serverText: document.getElementById("server-text")
};

/** Write a status line. Never includes form content, only counts. */
const setStatus = (text, isError = false) => {
  els.status.textContent = text;
  els.status.classList.toggle("error", isError);
};

const setBusy = (busy) => {
  const enabled = els.confirm.checked && !busy;
  els.answer.disabled = !enabled;
  els.clear.disabled = !enabled;
};

/**
 * The id of the tab the user is looking at. Works without the "tabs" permission:
 * we read only the id, never url or title.
 */
const activeTabId = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== "number") {
    throw new Error("No active tab.");
  }
  return tab.id;
};

/** Send one message to the content script and unwrap its {ok,data} envelope. */
const askContentScript = async (tabId, message) => {
  let response;
  try {
    response = await chrome.tabs.sendMessage(tabId, message);
  } catch {
    throw new Error(
      "Cannot reach the page. Open a Google Forms viewform page and reload it, then try again."
    );
  }

  if (!response || !response.ok) {
    throw new Error(response?.error || "The page script returned no result.");
  }
  return response.data;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Split a list into fixed-size chunks. Returns a new array of new arrays. */
const chunk = (items, size) =>
  Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, index * size + size)
  );

/** POST one batch of questions to the local server. */
const requestSuggestions = async (questions) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(SERVER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ questions }),
      signal: controller.signal
    });

    const text = await response.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`Server returned a non-JSON response (HTTP ${response.status}).`);
    }

    if (!response.ok) {
      const error = new Error(payload?.error || `Server error (HTTP ${response.status}).`);
      error.retryable = Boolean(payload?.retryable);
      error.retryAfterSeconds = Number(payload?.retryAfterSeconds) || 0;
      throw error;
    }
    return Array.isArray(payload.answers) ? payload.answers : [];
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Server did not respond within 60 seconds.");
    }
    if (error instanceof TypeError) {
      throw new Error("Local server unreachable. Start it with: npm start");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * One batch, retried only when the server says the failure was transient.
 *
 * The provider is the authority on how long to wait: if it sent a Retry-After,
 * that wins. Otherwise back off exponentially, because a fixed short delay just
 * walks straight back into the same rate limit.
 */
const requestWithRetry = async (batch, onNotice) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestSuggestions(batch);
    } catch (error) {
      if (!error.retryable || attempt >= RETRY_ATTEMPTS) throw error;

      const suggested = error.retryAfterSeconds * 1000;
      const backoff = RETRY_BASE_DELAY_MS * 2 ** attempt;
      const delay = Math.max(suggested, backoff);

      onNotice(
        `rate limited, waiting ${Math.round(delay / 1000)}s ` +
          `(attempt ${attempt + 1} of ${RETRY_ATTEMPTS})...`
      );
      await wait(delay);
    }
  }
};

const onAnswer = async () => {
  setBusy(true);
  setStatus("Reading visible questions...");

  try {
    const tabId = await activeTabId();
    const { questions } = await askContentScript(tabId, { type: "RFA_EXTRACT" });

    if (questions.length === 0) {
      setStatus(
        "No visible multiple-choice or checkbox questions found on this page.\n" +
          "Text, date, and file questions are intentionally ignored."
      );
      return;
    }

    /*
     * The server accepts 15 questions per request. Long forms are split here and
     * sent as consecutive requests, filling in each batch as it lands so partial
     * progress survives a failure part way through.
     */
    const batches = chunk(questions, MAX_QUESTIONS_PER_BATCH);
    const totals = { filled: 0, lowConfidence: 0, skipped: 0 };
    const failed = [];

    for (let index = 0; index < batches.length; index += 1) {
      const position = `batch ${index + 1} of ${batches.length}`;
      setStatus(`Answering ${questions.length} question(s), ${position}...`);

      /* Small gap between batches so a burst does not trip a per-minute limit. */
      if (index > 0) await wait(BETWEEN_BATCH_MS);

      let answers;
      try {
        answers = await requestWithRetry(batches[index], (notice) =>
          setStatus(`${position}: ${notice}`)
        );
      } catch (error) {
        /*
         * One bad batch must not cost the rest of the form. Record it and keep
         * going; the summary says which batches to re-run.
         */
        failed.push({ batch: index + 1, message: error.message });
        continue;
      }

      const result = await askContentScript(tabId, {
        type: "RFA_FILL",
        answers,
        lowConfidenceThreshold: LOW_CONFIDENCE_THRESHOLD
      });

      totals.filled += result.filled;
      totals.lowConfidence += result.lowConfidence;
      totals.skipped += result.skipped;
    }

    const lines = [
      `Processed ${totals.filled} of ${questions.length} question(s) in ${batches.length} batch(es).`,
      `${totals.lowConfidence} answer(s) below 65% confidence.`
    ];
    if (totals.skipped > 0) {
      lines.push(`${totals.skipped} suggestion(s) could not be matched to a choice.`);
    }
    if (failed.length > 0) {
      const numbers = failed.map((entry) => entry.batch).join(", ");
      lines.push(`Batch ${numbers} did not complete: ${failed[0].message}`);
      lines.push("Everything else is filled in. Run again to retry only what is still blank.");
    }
    lines.push("Nothing was submitted. Review every answer yourself.");

    setStatus(lines.join("\n"), failed.length > 0);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
};

const onClear = async () => {
  setBusy(true);
  setStatus("Clearing answers this extension filled in...");

  try {
    const tabId = await activeTabId();
    const { cleared } = await askContentScript(tabId, { type: "RFA_CLEAR" });
    setStatus(`Cleared ${cleared} selected choice(s) and removed all notes.`);
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
};

/*
 * Poll the local server for status. The response reports only whether a key is
 * configured; the key itself never crosses this boundary.
 */
const refreshServerState = async () => {
  try {
    const response = await fetch(HEALTH_URL, { cache: "no-store" });
    if (!response.ok) throw new Error("bad status");
    const health = await response.json();

    els.dot.classList.toggle("on", Boolean(health.keyConfigured));
    els.serverText.textContent = health.keyConfigured
      ? `${health.providerLabel}: ${health.model}`
      : `${health.providerLabel} selected, no API key yet`;
  } catch {
    els.dot.classList.remove("on");
    els.serverText.textContent = "Server not running";
  }
};

/* Opens the server's own setup page in a new tab. Needs no extra permission. */
els.setup.addEventListener("click", () => {
  chrome.tabs.create({ url: SETUP_URL });
});

els.confirm.addEventListener("change", () => {
  setBusy(false);
  setStatus(
    els.confirm.checked
      ? "Ready. Open the form page you want to work on, then choose an action."
      : "Confirm above to enable."
  );
});

els.answer.addEventListener("click", onAnswer);
els.clear.addEventListener("click", onClear);

refreshServerState();
