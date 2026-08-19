(() => {
const MESSAGE_SCHEMA_VERSION = 1;

const MESSAGE_TYPES = Object.freeze({
  PAGE_OBSERVE: "skfiy.page.observe",
  PAGE_OBSERVE_RESULT: "skfiy.page.observe_result",
  PAGE_DIAGNOSTICS: "skfiy.page.diagnostics",
  PAGE_DIAGNOSTICS_RESULT: "skfiy.page.diagnostics_result",
  PAGE_ACTION: "skfiy.page.action",
  PAGE_ACTION_RESULT: "skfiy.page.action_result",
  PAGE_CONTROL_HEALTH: "skfiy.page_control.health",
  PAGE_CONTROL_HEALTH_RESULT: "skfiy.page_control.health_result",
  PAGE_SENSITIVE_PAUSE: "skfiy.page.sensitive_pause"
});

const SENSITIVE_FIELD_PATTERNS = [
  /password/i,
  /passcode/i,
  /otp/i,
  /two[-_\s]?factor/i,
  /credit[-_\s]?card/i,
  /card[-_\s]?number/i,
  /security[-_\s]?code/i,
  /\bcvv\b/i,
  /token/i,
  /secret/i,
  /api[-_\s]?key/i
];

const PAGE_RISK_PATTERNS = [
  {
    kind: "credential",
    severity: "sensitive",
    pattern: /password|passcode|one[-\s]?time code|verification code|\botp\b|two[-\s]?factor|2fa/i,
    reason: "credential_or_otp_prompt"
  },
  {
    kind: "payment",
    severity: "sensitive",
    pattern: /payment|checkout|billing|credit card|card number|security code|\bcvv\b|bank account/i,
    reason: "payment_or_billing_flow"
  },
  {
    kind: "account-risk",
    severity: "destructive",
    pattern: /delete (my )?account|close (my )?account|deactivate account|remove account|permanently delete/i,
    reason: "account_deletion_flow"
  },
  {
    kind: "financial-transfer",
    severity: "destructive",
    pattern: /wire transfer|send money|transfer funds|withdraw funds|crypto withdrawal|bank transfer/i,
    reason: "financial_transfer_flow"
  },
  {
    kind: "secret-exposure",
    severity: "sensitive",
    pattern: /api key|secret key|access token|private token|recovery phrase|seed phrase/i,
    reason: "secret_exposure_flow"
  }
];

function textOf(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
}

function boundsFor(element) {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

function accessibleNameFor(element) {
  return (
    textOf(element.getAttribute("aria-label")) ||
    textOf(element.getAttribute("title")) ||
    textOf(element.innerText) ||
    textOf(element.getAttribute("name")) ||
    textOf(element.getAttribute("id"))
  );
}

function roleFor(element) {
  return textOf(element.getAttribute("role")) || element.tagName.toLowerCase();
}

function collectFormMetadata() {
  return Array.from(document.querySelectorAll("input, textarea, select, button"))
    .filter(isVisible)
    .slice(0, 200)
    .map((element, index) => ({
      id: `form-${index}`,
      tag: element.tagName.toLowerCase(),
      type: textOf(element.getAttribute("type")),
      name: textOf(element.getAttribute("name")),
      label: accessibleNameFor(element),
      role: roleFor(element),
      selector: selectorFor(element),
      bounds: boundsFor(element),
      sensitive: looksSensitive(element)
    }));
}

function collectInteractiveElements() {
  return Array.from(
    document.querySelectorAll("a, button, input, textarea, select, [role], [tabindex]")
  )
    .filter(isVisible)
    .slice(0, 300)
    .map((element, index) => ({
      id: `element-${index}`,
      role: roleFor(element),
      label: accessibleNameFor(element),
      selector: selectorFor(element),
      bounds: boundsFor(element)
    }));
}

function createActionReadiness(capable, reason, nextAction) {
  return {
    capable,
    state: capable ? "available" : "blocked",
    reason,
    nextAction
  };
}

function readPageControlReadiness(
  pageSafety = collectPageSafety(),
  forms = collectFormMetadata(),
  interactiveElements = collectInteractiveElements()
) {
  const sensitivePauseReason = document.documentElement.getAttribute("data-skfiy-sensitive-paused");
  const sensitivePauseKind = document.documentElement.getAttribute("data-skfiy-sensitive-pause-kind");
  const fillableForms = forms.filter((element) => ["input", "textarea", "select"].includes(element.tag));
  const sensitiveForms = forms.filter((element) => element.sensitive);
  const pageNeedsConfirmation = pageSafety.state === "needs_confirmation";
  const blockedReason = sensitivePauseReason
    ?? (pageNeedsConfirmation ? "Page safety requires confirmation before DOM actions." : null);
  const actionsBlocked = Boolean(blockedReason);
  const state = sensitivePauseReason
    ? "sensitive-paused"
    : pageNeedsConfirmation
      ? "needs_confirmation"
      : "ready";
  const actions = {
    click: createActionReadiness(
      !actionsBlocked && interactiveElements.length > 0,
      blockedReason ?? (interactiveElements.length > 0 ? "Clickable elements are available." : "No clickable elements detected."),
      blockedReason ? "confirm_sensitive_page" : "send_page_action"
    ),
    fill: createActionReadiness(
      !actionsBlocked && fillableForms.some((element) => !element.sensitive),
      blockedReason ?? (fillableForms.some((element) => !element.sensitive)
        ? "Non-sensitive fillable fields are available."
        : "No non-sensitive fillable fields detected."),
      blockedReason ? "confirm_sensitive_page" : "send_page_action"
    ),
    submit: createActionReadiness(
      !actionsBlocked && Boolean(document.querySelector("form")),
      blockedReason ?? (document.querySelector("form") ? "Forms are available." : "No forms detected."),
      blockedReason ? "confirm_sensitive_page" : "send_page_action"
    ),
    scroll: createActionReadiness(
      !actionsBlocked,
      blockedReason ?? "Scrolling is available.",
      blockedReason ? "confirm_sensitive_page" : "send_page_action"
    )
  };
  const capable = Object.values(actions).some((action) => action.capable);

  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    capable,
    state,
    reason: sensitivePauseReason
      ?? (pageNeedsConfirmation
        ? "Page safety requires confirmation before DOM actions."
        : "Content script loaded and DOM controls are available."),
    nextAction: blockedReason ? "confirm_sensitive_page" : "send_page_action",
    contentScript: {
      state: "loaded",
      diagnostics: true,
      observe: true,
      actions: true
    },
    capabilities: {
      diagnostics: true,
      observe: true,
      domActions: capable,
      click: actions.click.capable,
      fill: actions.fill.capable,
      submit: actions.submit.capable,
      scroll: actions.scroll.capable,
      screenshot: "background_required"
    },
    actions,
    forms: {
      total: forms.length,
      fillable: fillableForms.length,
      sensitive: sensitiveForms.length
    },
    sensitiveForms: sensitiveForms.map((element) => ({
      id: element.id,
      tag: element.tag,
      type: element.type,
      label: element.label,
      role: element.role,
      bounds: element.bounds
    })),
    counts: {
      interactiveElements: interactiveElements.length,
      forms: forms.length,
      fillableForms: fillableForms.length,
      sensitiveForms: sensitiveForms.length
    },
    pageSafety,
    sensitivePause: {
      active: Boolean(sensitivePauseReason),
      reason: sensitivePauseReason,
      kind: sensitivePauseKind
    }
  };
}

function selectorFor(element) {
  if (element.id) {
    return `#${CSS.escape(element.id)}`;
  }
  const name = element.getAttribute("name");
  if (name) {
    return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
  }
  return element.tagName.toLowerCase();
}

function capturePageSnapshot() {
  const safety = collectPageSafety();
  const forms = collectFormMetadata();
  const interactiveElements = collectInteractiveElements();

  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    url: location.href,
    host: location.host,
    title: document.title,
    visibleText: textOf(document.body?.innerText).slice(0, 20000),
    forms,
    interactiveElements,
    safety,
    pageControl: readPageControlReadiness(safety, forms, interactiveElements)
  };
}

function readContentScriptSession() {
  const sensitivePauseReason = document.documentElement.getAttribute("data-skfiy-sensitive-paused");
  const sensitivePauseKind = document.documentElement.getAttribute("data-skfiy-sensitive-pause-kind");
  const pageSafety = collectPageSafety();
  const forms = collectFormMetadata();
  const interactiveElements = collectInteractiveElements();
  const pageControl = readPageControlReadiness(pageSafety, forms, interactiveElements);

  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    state: "loaded",
    url: location.href,
    host: location.host,
    title: document.title,
    sensitivePaused: Boolean(sensitivePauseReason),
    sensitivePauseReason,
    sensitivePauseKind,
    pageSafety,
    pageControl,
    observedAt: new Date().toISOString()
  };
}

function readContentScriptProtocol() {
  return {
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    name: "skfiy.chrome.page-control.content-script",
    state: "loaded",
    messageTypes: {
      health: MESSAGE_TYPES.PAGE_CONTROL_HEALTH,
      healthResult: MESSAGE_TYPES.PAGE_CONTROL_HEALTH_RESULT,
      diagnostics: MESSAGE_TYPES.PAGE_DIAGNOSTICS,
      observe: MESSAGE_TYPES.PAGE_OBSERVE,
      action: MESSAGE_TYPES.PAGE_ACTION
    },
    capabilities: {
      health: true,
      diagnostics: true,
      observe: true,
      domActions: true,
      click: true,
      fill: true,
      submit: true,
      scroll: true,
      screenshot: "background_required"
    }
  };
}

function collectPageSafety() {
  const haystack = [
    document.title,
    document.body?.innerText,
    document.body?.textContent
  ].map(textOf).join("\n").slice(0, 40000);
  const findings = PAGE_RISK_PATTERNS
    .filter((entry) => entry.pattern.test(haystack))
    .slice(0, 8)
    .map((entry) => ({
      kind: entry.kind,
      severity: entry.severity,
      reason: entry.reason
    }));

  return {
    state: findings.length > 0 ? "needs_confirmation" : "clear",
    findingCount: findings.length,
    findings
  };
}

function looksSensitive(element, value = "") {
  const haystack = [
    element.getAttribute("type"),
    element.getAttribute("name"),
    element.getAttribute("id"),
    element.getAttribute("autocomplete"),
    element.getAttribute("aria-label"),
    element.getAttribute("placeholder"),
    value
  ]
    .map(textOf)
    .join(" ");

  return SENSITIVE_FIELD_PATTERNS.some((pattern) => pattern.test(haystack));
}

function markSensitivePause(reason, action, safety) {
  document.documentElement.setAttribute("data-skfiy-sensitive-paused", reason);
  document.documentElement.setAttribute("data-skfiy-sensitive-pause-kind", action?.kind ?? action?.type ?? "unknown");
  void chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.PAGE_SENSITIVE_PAUSE,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    url: location.href,
    host: location.host,
    reason,
    actionType: action?.kind ?? action?.type ?? "unknown",
    ...(safety ? { safety } : {})
  });
  return {
    type: MESSAGE_TYPES.PAGE_ACTION_RESULT,
    schemaVersion: MESSAGE_SCHEMA_VERSION,
    result: "sensitive-paused",
    reason,
    ...(safety ? { safety } : {})
  };
}

function elementByText(text) {
  const wanted = textOf(text).toLowerCase();
  if (!wanted) {
    return null;
  }

  return Array.from(document.querySelectorAll("a, button, input, textarea, select, [role], [tabindex]"))
    .filter(isVisible)
    .find((element) => accessibleNameFor(element).toLowerCase().includes(wanted)) ?? null;
}

function elementByRole(role, name = "") {
  const wantedRole = textOf(role).toLowerCase();
  const wantedName = textOf(name).toLowerCase();
  if (!wantedRole) {
    return null;
  }

  return Array.from(document.querySelectorAll("a, button, input, textarea, select, [role], [tabindex]"))
    .filter(isVisible)
    .find((element) => {
      const roleMatches = roleFor(element).toLowerCase() === wantedRole;
      const nameMatches = !wantedName || accessibleNameFor(element).toLowerCase().includes(wantedName);
      return roleMatches && nameMatches;
    }) ?? null;
}

function elementForAction(action) {
  if (action.selector) {
    return document.querySelector(action.selector);
  }
  if (action.text) {
    return elementByText(action.text);
  }
  if (action.role) {
    return elementByRole(action.role, action.name);
  }
  return null;
}

function runPageAction(action) {
  if (!action || typeof action !== "object") {
    return { result: "blocked", reason: "missing_action" };
  }

  const pageSafety = collectPageSafety();
  const sensitivePauseReason = document.documentElement.getAttribute("data-skfiy-sensitive-paused");
  const pauseableAction = ["click", "fill", "submit", "scroll"].includes(action?.kind);
  if (sensitivePauseReason && pauseableAction && action?.confirmed !== true) {
    return markSensitivePause(sensitivePauseReason, action, pageSafety);
  }

  const confirmationRequired = action?.confirmed !== true
    && ["click", "fill", "submit"].includes(action?.kind)
    && pageSafety.state === "needs_confirmation";

  if (confirmationRequired) {
    return markSensitivePause("Sensitive page content requires confirmation", action, pageSafety);
  }

  if (action.kind === "navigate" && action.url) {
    location.assign(action.url);
    return { result: "started", action: "navigate" };
  }

  const element = elementForAction(action);

  if ((action.kind === "fill" || action.kind === "click") && element && looksSensitive(element, action.value)) {
    return markSensitivePause("Sensitive content pause", action, pageSafety);
  }

  if (action.kind === "focus" && element) {
    element.focus();
    return { result: "passed", action: "focus" };
  }

  if (action.kind === "fill" && element) {
    element.focus();
    element.value = action.value ?? "";
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { result: "passed", action: "fill" };
  }

  if (action.kind === "click" && element) {
    element.click();
    return { result: "passed", action: "click" };
  }

  if (action.kind === "submit" && element && action.confirmed === true) {
    const form = element.matches?.("form") ? element : element.closest?.("form");
    if (form?.requestSubmit) {
      form.requestSubmit();
    } else if (form?.submit) {
      form.submit();
    } else {
      element.click();
    }
    return { result: "passed", action: "submit" };
  }

  if (action.kind === "scroll") {
    window.scrollBy({ top: action.deltaY ?? 0, left: action.deltaX ?? 0, behavior: "auto" });
    return { result: "passed", action: "scroll" };
  }

  return { result: "blocked", reason: "unsupported_or_missing_target" };
}

const previousSkfiyContentScriptOnMessage = globalThis.__skfiyContentScriptOnMessage;
if (typeof previousSkfiyContentScriptOnMessage === "function") {
  chrome.runtime.onMessage.removeListener(previousSkfiyContentScriptOnMessage);
}

const handleSkfiyContentScriptMessage = (message, _sender, sendResponse) => {
  if (message?.type === MESSAGE_TYPES.PAGE_CONTROL_HEALTH) {
    const session = readContentScriptSession();
    sendResponse({
      type: MESSAGE_TYPES.PAGE_CONTROL_HEALTH_RESULT,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId,
      protocol: readContentScriptProtocol(),
      session,
      pageControl: session.pageControl,
      blockers: Array.isArray(session.pageControl?.blockers) ? session.pageControl.blockers : []
    });
    return true;
  }

  if (message?.type === MESSAGE_TYPES.PAGE_DIAGNOSTICS) {
    sendResponse({
      type: MESSAGE_TYPES.PAGE_DIAGNOSTICS_RESULT,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId,
      session: readContentScriptSession()
    });
    return true;
  }

  if (message?.type === MESSAGE_TYPES.PAGE_OBSERVE) {
    sendResponse({
      type: MESSAGE_TYPES.PAGE_OBSERVE_RESULT,
      requestId: message.requestId,
      snapshot: capturePageSnapshot()
    });
    return true;
  }

  if (message?.type === MESSAGE_TYPES.PAGE_ACTION) {
    const action = message.payload?.action ?? message.action ?? message;
    sendResponse({
      type: MESSAGE_TYPES.PAGE_ACTION_RESULT,
      schemaVersion: MESSAGE_SCHEMA_VERSION,
      requestId: message.requestId,
      ...runPageAction(action)
    });
    return true;
  }

  return false;
};

globalThis.__skfiyContentScriptOnMessage = handleSkfiyContentScriptMessage;
chrome.runtime.onMessage.addListener(handleSkfiyContentScriptMessage);
})();
