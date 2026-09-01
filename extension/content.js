/*
 * Review Form Assistant - content script.
 *
 * Scope of this file, deliberately narrow:
 *   - Reads visible radio ("multiple choice") and checkbox questions from the
 *     Google Forms page that is currently open.
 *   - Selects choices that the local server suggested.
 *   - Renders a short confidence/explanation note under each answered question.
 *
 * Things this file never does, by construction:
 *   - It never queries, locates, or clicks a Submit / Next / Back control.
 *     There is no selector in this file that can match one.
 *   - It never reads text inputs, email fields, cookies, storage, or any page
 *     content outside the question list items it extracts.
 *   - It performs no network requests of any kind. The popup owns all I/O.
 */

(() => {
  "use strict";

  // Marker class for the notes we inject, so we can remove exactly our own nodes.
  const NOTE_CLASS = "rfa-note";

  // Bound the payload so a pathological page cannot push a huge body to the server.
  const MAX_QUESTION_CHARS = 600;
  const MAX_CHOICE_CHARS = 300;
  const MAX_CHOICES = 20;

  /*
   * Per-run memory only. Question ids are regenerated on every extraction and
   * are never persisted to disk, storage, or anywhere outside this page.
   * Maps question id -> the listitem element it came from.
   */
  let currentRun = new Map();

  /** True when an element is rendered and not aria-hidden. */
  const isVisible = (el) => {
    if (!el || el.getAttribute("aria-hidden") === "true") return false;
    const rects = el.getClientRects();
    return rects.length > 0;
  };

  /** Collapse whitespace and cap length. Returns a new string. */
  const tidy = (value, max) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);

  /** The question prompt for one form item. */
  const headingText = (item) => {
    const heading = item.querySelector('[role="heading"]');
    return tidy(heading ? heading.textContent : "", MAX_QUESTION_CHARS);
  };

  /**
   * The selectable choices for one form item.
   * Google Forms renders choices as div[role="radio"] or div[role="checkbox"],
   * with the human-readable label in aria-label (or data-value on older DOMs).
   */
  const choiceElements = (item) => {
    const radios = Array.from(item.querySelectorAll('[role="radio"]'));
    if (radios.length > 0) return { type: "radio", elements: radios };

    const boxes = Array.from(item.querySelectorAll('[role="checkbox"]'));
    if (boxes.length > 0) return { type: "checkbox", elements: boxes };

    return { type: null, elements: [] };
  };

  const choiceLabel = (el) =>
    tidy(
      el.getAttribute("aria-label") || el.getAttribute("data-value") || el.textContent,
      MAX_CHOICE_CHARS
    );

  /**
   * Build the extraction payload. Returns a plain object; nothing is mutated
   * on the page during extraction.
   */
  const extract = () => {
    const items = Array.from(document.querySelectorAll('div[role="listitem"]'));
    const run = new Map();
    const questions = [];

    items.forEach((item, itemIndex) => {
      if (!isVisible(item)) return;

      const { type, elements } = choiceElements(item);
      if (!type) return; // text / date / file items are skipped entirely

      const visibleChoices = elements.filter(isVisible).slice(0, MAX_CHOICES);
      if (visibleChoices.length === 0) return;

      const text = headingText(item);
      if (!text) return;

      // Temporary, per-run id. Not stable across runs, not stored.
      const id = `q${itemIndex}`;
      run.set(id, item);

      questions.push({
        id,
        type,
        text,
        choices: visibleChoices.map(choiceLabel)
      });
    });

    currentRun = run;
    return { questions };
  };

  /** Remove only the notes this extension injected. */
  const removeNotes = (root) => {
    root.querySelectorAll(`.${NOTE_CLASS}`).forEach((node) => node.remove());
  };

  /** Render the confidence / explanation line beneath one question. */
  const addNote = (item, answer, lowConfidence) => {
    removeNotes(item);

    const note = document.createElement("div");
    note.className = NOTE_CLASS;
    note.style.cssText = [
      "margin:8px 0 4px",
      "padding:6px 8px",
      "border-left:3px solid " + (lowConfidence ? "#c1121f" : "#4a7c59"),
      "background:rgba(0,0,0,0.04)",
      "font:12px/1.45 system-ui, sans-serif",
      "color:#333",
      "white-space:normal"
    ].join(";");

    const pct = Math.round(answer.confidence * 100);
    note.textContent =
      `Suggestion confidence ${pct}%${lowConfidence ? " (low)" : ""}. ` +
      `${answer.explanation} AI suggestions can be wrong; verify before relying on them.`;

    item.appendChild(note);
  };

  /**
   * Apply server suggestions. Only elements inside a question listitem that was
   * part of the most recent extraction are ever clicked.
   */
  const fill = (answers, lowConfidenceThreshold) => {
    let filled = 0;
    let lowConfidence = 0;
    let skipped = 0;

    answers.forEach((answer) => {
      const item = currentRun.get(answer.id);
      if (!item) {
        skipped += 1;
        return;
      }

      const { elements } = choiceElements(item);
      const visibleChoices = elements.filter(isVisible).slice(0, MAX_CHOICES);
      const target = visibleChoices[answer.index];

      if (!target) {
        skipped += 1;
        return;
      }

      if (target.getAttribute("aria-checked") !== "true") {
        target.click();
      }

      const isLow = answer.confidence < lowConfidenceThreshold;
      if (isLow) lowConfidence += 1;

      addNote(item, answer, isLow);
      filled += 1;
    });

    return { filled, lowConfidence, skipped };
  };

  /**
   * Undo what this extension did: deselect any choice that is currently checked
   * inside a question we touched, and remove our notes. Google Forms allows a
   * selected radio to be deselected by clicking it again.
   */
  const clear = () => {
    let cleared = 0;

    currentRun.forEach((item) => {
      const { elements } = choiceElements(item);
      elements.filter(isVisible).forEach((el) => {
        if (el.getAttribute("aria-checked") === "true") {
          el.click();
          cleared += 1;
        }
      });
      removeNotes(item);
    });

    // Sweep any stray notes left over from an earlier run on this page.
    removeNotes(document);
    return { cleared };
  };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message?.type === "RFA_EXTRACT") {
        sendResponse({ ok: true, data: extract() });
        return false;
      }

      if (message?.type === "RFA_FILL") {
        const result = fill(message.answers ?? [], message.lowConfidenceThreshold ?? 0.65);
        sendResponse({ ok: true, data: result });
        return false;
      }

      if (message?.type === "RFA_CLEAR") {
        sendResponse({ ok: true, data: clear() });
        return false;
      }

      sendResponse({ ok: false, error: `Unknown message type: ${message?.type}` });
      return false;
    } catch (error) {
      sendResponse({ ok: false, error: String(error && error.message ? error.message : error) });
      return false;
    }
  });
})();
