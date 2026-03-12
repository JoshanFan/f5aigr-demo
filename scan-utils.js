const PASS_OUTCOMES = new Set(["passed", "pass", "informational", "cleared", "allow", "allowed"]);
const BLOCK_OUTCOMES = new Set(["blocked", "block", "failed", "deny", "denied", "rejected"]);
const REVIEW_OUTCOMES = new Set(["review", "warning", "warn", "flagged", "caution"]);

function normalizeOutcome(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isPassOutcome(value) {
  return PASS_OUTCOMES.has(normalizeOutcome(value));
}

function isBlockOutcome(value) {
  return BLOCK_OUTCOMES.has(normalizeOutcome(value));
}

function isReviewOutcome(value) {
  return REVIEW_OUTCOMES.has(normalizeOutcome(value));
}

export function resolveScannerName(scanner, scannerCatalog) {
  if (!scanner || typeof scanner !== "object") {
    return "unknown_scanner";
  }

  if (typeof scanner.scannerName === "string" && scanner.scannerName.trim()) {
    return scanner.scannerName.trim();
  }
  if (typeof scanner.scanType === "string" && scanner.scanType.trim()) {
    return scanner.scanType.trim();
  }
  if (typeof scanner.scannerType === "string" && scanner.scannerType.trim()) {
    return scanner.scannerType.trim();
  }

  const scannerId = typeof scanner.scannerId === "string" ? scanner.scannerId : "";
  if (scannerId && scannerCatalog && typeof scannerCatalog === "object") {
    const scannerMeta = scannerCatalog[scannerId];
    if (scannerMeta && typeof scannerMeta.name === "string" && scannerMeta.name.trim()) {
      return scannerMeta.name.trim();
    }
  }

  return scannerId || "unknown_scanner";
}

function resolveScannerCreatedBy(scanner, scannerCatalog) {
  if (!scanner || typeof scanner !== "object") {
    return "";
  }

  const fromScannerVersionMeta =
    scanner.scannerVersionMeta && typeof scanner.scannerVersionMeta === "object"
      ? scanner.scannerVersionMeta.createdBy || scanner.scannerVersionMeta.create_by || ""
      : "";
  if (typeof fromScannerVersionMeta === "string" && fromScannerVersionMeta.trim()) {
    return fromScannerVersionMeta.trim();
  }

  const scannerId = typeof scanner.scannerId === "string" ? scanner.scannerId : "";
  if (scannerId && scannerCatalog && typeof scannerCatalog === "object") {
    const scannerMeta = scannerCatalog[scannerId];
    if (scannerMeta && typeof scannerMeta === "object") {
      const fromCatalogVersionMeta =
        scannerMeta.versionMeta && typeof scannerMeta.versionMeta === "object"
          ? scannerMeta.versionMeta.createdBy || scannerMeta.versionMeta.create_by || ""
          : "";
      if (typeof fromCatalogVersionMeta === "string" && fromCatalogVersionMeta.trim()) {
        return fromCatalogVersionMeta.trim();
      }

      const fromCatalog = scannerMeta.createdBy || scannerMeta.create_by || "";
      if (typeof fromCatalog === "string" && fromCatalog.trim()) {
        return fromCatalog.trim();
      }
    }
  }

  return "";
}

export function resolveScannerPolicyType(scanner, scannerCatalog) {
  const createdBy = resolveScannerCreatedBy(scanner, scannerCatalog);
  return createdBy.toLowerCase() === "system" ? "System" : "Custom";
}

function formatThreat(scanner, scannerCatalog) {
  const name = resolveScannerName(scanner, scannerCatalog);
  const data = scanner.data && typeof scanner.data === "object" ? scanner.data : {};
  const outcome = normalizeOutcome(scanner?.outcome);
  const reason =
    data.reason ||
    data.message ||
    data.label ||
    data.type ||
    (Array.isArray(data.matches) && data.matches.length > 0 ? "match detected" : "");
  const normalizedReason = typeof reason === "string" && reason.trim().toLowerCase() === "custom" ? "" : reason;
  const fallbackReason = normalizedReason || (outcome ? `outcome: ${outcome}` : "policy signal detected");
  return `${name}: ${fallbackReason}`;
}

function mapOutcomeToVerdict(outcome, nonPassCount) {
  const normalized = normalizeOutcome(outcome);
  if (isBlockOutcome(normalized)) {
    return "Block";
  }
  if (isReviewOutcome(normalized) || nonPassCount > 0) {
    return "Review";
  }
  return "Allow";
}

function mapVerdictToLevel(verdict) {
  if (verdict === "Block") {
    return "high";
  }
  if (verdict === "Review") {
    return "medium";
  }
  return "low";
}

function mapCommon(payload, metaConfig) {
  const source = payload && typeof payload === "object" ? payload : {};
  const result = source.result && typeof source.result === "object" ? source.result : {};
  const scannerResults = Array.isArray(result.scannerResults) ? result.scannerResults : [];
  const scannerCatalog =
    source.scanners &&
    typeof source.scanners === "object" &&
    source.scanners.scanners &&
    typeof source.scanners.scanners === "object"
      ? source.scanners.scanners
      : {};
  const outcome = normalizeOutcome(result.outcome);
  const nonPassResults = scannerResults.filter((scanner) => !isPassOutcome(scanner?.outcome));

  const verdict = mapOutcomeToVerdict(outcome, nonPassResults.length);
  const level = mapVerdictToLevel(verdict);
  const threats =
    nonPassResults.length > 0
      ? nonPassResults.map((scanner) => formatThreat(scanner, scannerCatalog))
      : ["No major threat detected."];
  const preview = typeof metaConfig.previewValue === "string" ? metaConfig.previewValue : "";
  const detailValue = typeof metaConfig.detailValue === "string" ? metaConfig.detailValue : String(metaConfig.detailValue ?? "");

  return {
    verdict,
    level,
    threats,
    outcome: outcome || "unknown",
    scannerResults,
    scannerCatalog,
    meta: {
      outcome: outcome || "unknown",
      requestId: source.id || "",
      totalScanners: scannerResults.length,
      flaggedScanners: nonPassResults.length,
      previewLabel: metaConfig.previewLabel || "Context Preview",
      preview,
      sourceType: metaConfig.sourceType || "unknown",
      apiPath: metaConfig.apiPath || "",
      detailLabel: metaConfig.detailLabel || "Detail",
      detailValue: detailValue || "N/A",
    },
  };
}

export function mapScanApiResult(payload) {
  const preview =
    payload && typeof payload.redactedInput === "string"
      ? payload.redactedInput
      : payload?.result && typeof payload.result.redactedInput === "string"
        ? payload.result.redactedInput
        : "";
  const redactionSummary = preview ? `${preview.length} chars` : "No redacted input";
  return mapCommon(payload, {
    sourceType: "oob",
    apiPath: "/backend/v1/scans",
    previewLabel: "Redacted Input",
    previewValue: preview,
    detailLabel: "Redaction",
    detailValue: redactionSummary,
  });
}

function summarizeProviderResult(providerResult) {
  if (providerResult == null) {
    return "N/A";
  }

  if (typeof providerResult === "string") {
    return providerResult.slice(0, 180);
  }

  if (typeof providerResult !== "object") {
    return String(providerResult);
  }

  if (Number.isFinite(providerResult.statusCode)) {
    return `HTTP ${providerResult.statusCode}`;
  }

  const candidateValues = [
    providerResult.status,
    providerResult.outcome,
    providerResult.provider,
    providerResult.model,
    providerResult.finishReason,
  ].filter((value) => typeof value === "string" && value.trim());

  if (candidateValues.length > 0) {
    return candidateValues.slice(0, 3).join(" • ");
  }

  return "Object payload";
}

export function mapPromptApiResult(payload) {
  const preview = payload?.result && typeof payload.result.response === "string" ? payload.result.response : "";
  const providerSummary = summarizeProviderResult(payload?.result?.providerResult);
  return mapCommon(payload, {
    sourceType: "inline",
    apiPath: "/backend/v1/prompts",
    previewLabel: "Model Response",
    previewValue: preview,
    detailLabel: "Provider",
    detailValue: providerSummary,
  });
}
