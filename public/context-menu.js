// One menu model and one interaction controller for every selectable run.
// Provider association and persisted action state are supplied by the app;
// this module never infers a PR from a visible number or a workflow name.
export function runActionDefinitions({ row, links, association, pinned, runArmed, prArmed, scopeLabel = "this view" }) {
  const terminal = (row.providerState || row.state) === "completed";
  const unavailable = row.providerUnavailable === true || row.pinStatus === "unavailable";
  const prReason = association?.reason || "No verified, unambiguous PR association is available.";
  const prAvailable = association?.status === "resolved" && Boolean(links.pr);
  const restoring = row.pinStatus === "restoring" || row.actionsAvailable === false;
  const actionReason = row.actionsUnavailableReason || "This retained attempt is read-only; its current provider state must be verified before watch or acknowledgement actions.";
  const runReason = unavailable || restoring ? "GitHub cannot currently verify this run." : terminal
    ? "This attempt has already completed. No retrospective alert will sound."
    : !["queued", "in_progress"].includes(row.providerState || row.state) ? "This run has no verified active attempt." : "";
  return [
    { id: "copy-ci", label: "Copy CI link", disabled: !links.ci, reason: "No valid GitHub run URL is available." },
    { id: "copy-pr", label: "Copy PR link", disabled: !prAvailable, reason: prReason },
    { id: runArmed ? "cancel-run" : "arm-run", label: runArmed ? "Cancel run alert" : "Alert when run completes",
      checked: Boolean(runArmed), disabled: !runArmed && Boolean(runReason), reason: runReason },
    { id: prArmed ? "cancel-pr" : "arm-pr", label: prArmed ? "Cancel PR alert" : "Alert when PR checks complete",
      checked: Boolean(prArmed), disabled: !prArmed && !prAvailable, reason: prReason },
    { separator: true },
    { id: pinned ? "unpin" : "pin", label: pinned ? "Unpin" : "Pin to top", checked: Boolean(pinned),
      description: "Applies only to " + scopeLabel + ". Pins do not change watching or completion alerts." },
    { id: "watch", label: row.manualWatch ? "Stop watching" : "Watch run", checked: Boolean(row.manualWatch),
      disabled: row.actionsAvailable === false, reason: actionReason },
    ...(!row.acknowledged && ["failure", "timed_out", "action_required", "startup_failure"].includes(row.conclusion)
      ? [{ id: "acknowledge", label: "Acknowledge failure", disabled: row.actionsAvailable === false, reason: actionReason }] : []),
    { id: "open-ci", label: "Open CI on GitHub", disabled: !links.ci, reason: "No valid GitHub run URL is available." },
    { id: "open-pr", label: "Open related PR", disabled: !prAvailable, reason: prReason },
    { id: "open-commit", label: "Open commit", disabled: !links.commit, reason: "No verified commit SHA is available." },
    { id: "copy-sha", label: "Copy commit SHA", disabled: !links.sha, reason: "No verified commit SHA is available." },
    { id: "workflow-history", label: "Show other runs of this workflow" }
  ];
}

export async function copyText(text, navigatorObject = globalThis.navigator, documentObject = globalThis.document) {
  if (!text) throw new Error("Nothing to copy");
  if (navigatorObject?.clipboard?.writeText) {
    try { await navigatorObject.clipboard.writeText(text); return; }
    catch { /* Firefox may disallow clipboard while document lacks permission. */ }
  }
  const active = documentObject.activeElement;
  const selection = documentObject.getSelection?.();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const input = documentObject.createElement("textarea");
  input.value = text;
  input.className = "context-copy-fallback";
  input.setAttribute("aria-label", "Copy link");
  input.setAttribute("readonly", "");
  documentObject.body.append(input);
  input.focus({ preventScroll: true });
  input.select();
  let copied = false;
  try { copied = documentObject.execCommand("copy"); }
  finally {
    input.remove();
    if (active?.isConnected) active.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
  if (!copied) throw new Error("Browser denied clipboard access");
}

export function createContextMenu({ root, resolveTarget, onSelect, onOpen, onError = () => {} }) {
  const documentObject = root.ownerDocument;
  const windowObject = documentObject.defaultView;
  const menu = documentObject.createElement("div");
  menu.id = "runContextMenu";
  menu.className = "run-context-menu";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", "Workflow run actions");
  menu.hidden = true;
  documentObject.body.append(menu);
  let origin = null, context = null, point = null, anchorPosition = null;
  let model = [];
  const eligible = element => element?.closest?.("[data-run-context]");
  const editable = element => Boolean(element?.closest?.("input, textarea, select, [contenteditable='true'], .focus-grid-resize, .focus-sort-button"));
  const buttons = () => [...menu.querySelectorAll('[role^="menuitem"]')];

  function close(restore = false) {
    if (menu.hidden) return;
    const previous = origin;
    menu.hidden = true;
    menu.replaceChildren();
    origin = context = point = anchorPosition = null;
    if (restore && previous?.isConnected) previous.focus({ preventScroll: true });
  }
  function place() {
    if (!point || menu.hidden) return;
    const rect = menu.getBoundingClientRect();
    // Prefer the exact click coordinate: the first action is immediately
    // beneath it. Flip only when needed, then clamp for very small popups.
    const inset = 4;
    const width = windowObject.innerWidth, height = windowObject.innerHeight;
    const left = point.x + rect.width <= width - inset ? point.x : point.x - rect.width;
    const top = point.y + rect.height <= height - inset ? point.y : point.y - rect.height;
    menu.style.left = Math.max(inset, Math.min(left, width - rect.width - inset)) + "px";
    menu.style.top = Math.max(inset, Math.min(top, height - rect.height - inset)) + "px";
  }
  function draw(focusId = "") {
    model = runActionDefinitions(context);
    menu.replaceChildren();
    for (const action of model) {
      if (action.separator) {
        const divider = documentObject.createElement("div");
        divider.className = "context-menu-divider";
        divider.setAttribute("role", "separator");
        menu.append(divider);
        continue;
      }
      const button = documentObject.createElement("button");
      button.type = "button";
      button.className = "context-menu-action";
      button.dataset.action = action.id;
      button.setAttribute("role", Object.hasOwn(action, "checked") ? "menuitemcheckbox" : "menuitem");
      if (Object.hasOwn(action, "checked")) button.setAttribute("aria-checked", String(action.checked));
      button.setAttribute("aria-disabled", String(Boolean(action.disabled)));
      button.tabIndex = -1;
      const marker = documentObject.createElement("span");
      marker.className = "context-menu-check";
      marker.setAttribute("aria-hidden", "true");
      marker.textContent = action.checked ? "✓" : "";
      button.append(marker, documentObject.createTextNode(action.label));
      const explanation = action.disabled ? action.reason : action.description;
      if (explanation) {
        button.title = explanation;
        button.setAttribute("aria-description", explanation);
      }
      button.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        if (action.disabled) return;
        const selected = context;
        close(true);
        // Invoke synchronously inside the gesture so Web Audio and external
        // window opening retain the browser's user activation permission.
        try { Promise.resolve(onSelect(action.id, selected)).catch(onError); }
        catch (error) { onError(error); }
      });
      menu.append(button);
    }
    place();
    const focus = buttons().find(button => button.dataset.action === focusId);
    if (focus) focus.focus({ preventScroll: true });
    else buttons()[0]?.focus({ preventScroll: true });
  }
  function open(element, event, keyboard) {
    const next = resolveTarget(element);
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    close(false);
    origin = element;
    context = next;
    const rect = element.getBoundingClientRect();
    anchorPosition = { left: rect.left, top: rect.top };
    point = keyboard ? { x: Math.max(4, rect.left + 12), y: Math.max(4, rect.top + Math.min(rect.height, 24)) }
      : { x: event.clientX, y: event.clientY };
    menu.hidden = false;
    draw();
    onOpen?.(context);
  }
  function contextListener(event) {
    // Firefox intentionally reserves Shift+right-click for its native menu.
    if (event.shiftKey) { close(false); return; }
    if (editable(event.target)) return;
    const target = eligible(event.target);
    if (target && root.contains(target)) open(target, event, false);
  }
  function keyListener(event) {
    if (!menu.hidden && menu.contains(event.target)) {
      const list = buttons();
      const current = list.indexOf(documentObject.activeElement);
      let index;
      if (event.key === "ArrowDown") index = (current + 1) % list.length;
      if (event.key === "ArrowUp") index = (current + list.length - 1) % list.length;
      if (event.key === "Home") index = 0;
      if (event.key === "End") index = list.length - 1;
      if (index !== undefined) {
        event.preventDefault(); event.stopPropagation();
        list[index]?.focus({ preventScroll: true });
        return;
      }
    }
    if (!menu.hidden && event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); close(true); return;
    }
    if (!menu.hidden && event.key === "Tab") {
      // Return to the row, then let the browser perform normal tab traversal.
      close(true); return;
    }
    if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
    if (editable(event.target)) return;
    const target = eligible(event.target);
    if (target && root.contains(target)) open(target, event, true);
  }
  function outside(event) {
    if (!menu.hidden && !menu.contains(event.target)) close(false);
  }
  function scroll(event) {
    if (menu.hidden || menu.contains(event.target)) return;
    if (!origin?.isConnected || !anchorPosition) { close(false); return; }
    const rect = origin.getBoundingClientRect();
    // Browsers queue scroll events from focus()/scrollIntoView and grid
    // restoration. A keyboard menu can open after the movement but before
    // that old event is dispatched. Only actual movement since opening can
    // detach this menu from its originating row; an unrelated pane's scroll
    // or an already-completed scroll must not dismiss a new menu.
    if (Math.abs(rect.left - anchorPosition.left) > 0.5 ||
        Math.abs(rect.top - anchorPosition.top) > 0.5) close(false);
  }
  root.addEventListener("contextmenu", contextListener);
  documentObject.addEventListener("keydown", keyListener, true);
  documentObject.addEventListener("pointerdown", outside, true);
  documentObject.addEventListener("scroll", scroll, true);
  windowObject.addEventListener("resize", place);
  return {
    close,
    isOpen: () => !menu.hidden,
    reconcile() {
      if (menu.hidden || !context) return;
      const candidates = root.querySelectorAll("[data-run-context]");
      const replacement = [...candidates].find(element =>
        element.dataset.runKey === origin?.dataset.runKey &&
        element.dataset.runScope === origin?.dataset.runScope);
      const next = replacement && resolveTarget(replacement);
      if (!next) { close(false); return; }
      const focused = menu.contains(documentObject.activeElement)
        ? documentObject.activeElement.dataset.action : "";
      origin = replacement;
      context = next;
      // An async association resolution or remote cancellation updates the
      // current menu state without moving it or reactivating the row.
      draw(focused);
    },
    destroy() {
      close(false);
      root.removeEventListener("contextmenu", contextListener);
      documentObject.removeEventListener("keydown", keyListener, true);
      documentObject.removeEventListener("pointerdown", outside, true);
      documentObject.removeEventListener("scroll", scroll, true);
      windowObject.removeEventListener("resize", place);
      menu.remove();
    }
  };
}
