import type { CognitiveModality, ObservationInput } from "./types.js";

export type IngestionKind =
  | "generic"
  | "prometheus_alert"
  | "syslog"
  | "webhook"
  | "vision"
  | "audio"
  | "sensor";

export type IngestionEnvelope = {
  kind: IngestionKind;
  source?: string;
  payload: Record<string, unknown>;
  receivedAt?: number;
};

const MAX_STRING = 1_200;
const MAX_ARRAY = 32;
const MAX_OBJECT_KEYS = 64;

function cleanText(value: unknown, fallback = "", maxLength = MAX_STRING): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, maxLength);
}

function cleanNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function cleanBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asRecordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .map(asRecord)
        .filter((item): item is Record<string, unknown> => Boolean(item))
        .slice(0, MAX_ARRAY)
    : [];
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => cleanText(item, "", 200))
    .filter(Boolean)
    .slice(0, MAX_ARRAY);
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
    const cleanedKey = cleanText(key, "", 100);
    if (!cleanedKey) {
      continue;
    }
    if (typeof item === "string") {
      result[cleanedKey] = cleanText(item, "", 500);
    } else if (typeof item === "number" && Number.isFinite(item)) {
      result[cleanedKey] = item;
    } else if (typeof item === "boolean" || item === null) {
      result[cleanedKey] = item;
    } else if (Array.isArray(item)) {
      result[cleanedKey] = item
        .slice(0, 16)
        .map((entry) =>
          typeof entry === "string"
            ? cleanText(entry, "", 200)
            : typeof entry === "number" || typeof entry === "boolean"
              ? entry
              : "[structured]",
        );
    } else if (item && typeof item === "object") {
      result[cleanedKey] = "[structured]";
    }
  }
  return result;
}

function severityConfidence(severity: string): { salience: number; confidence: number } {
  const normalized = severity.toLocaleLowerCase();
  if (/emerg|alert|critical|crit|fatal|panic/u.test(normalized)) {
    return { salience: 0.96, confidence: 0.9 };
  }
  if (/error|err|high|warning|warn/u.test(normalized)) {
    return { salience: 0.82, confidence: 0.84 };
  }
  if (/notice|medium|info/u.test(normalized)) {
    return { salience: 0.58, confidence: 0.78 };
  }
  return { salience: 0.45, confidence: 0.7 };
}

function genericObservation(
  modality: CognitiveModality,
  summary: string,
  source: string | undefined,
  data: Record<string, unknown>,
  salience?: number,
  confidence?: number,
): ObservationInput {
  return {
    modality,
    summary: cleanText(summary, "Unspecified event"),
    source: source ? cleanText(source, "", 200) : undefined,
    salience,
    confidence,
    data: compactObject(data),
  };
}

function normalizePrometheus(envelope: IngestionEnvelope): ObservationInput[] {
  const payload = envelope.payload;
  const alerts = asRecordArray(payload.alerts);
  if (alerts.length === 0) {
    const labels = asRecord(payload.labels) ?? {};
    const annotations = asRecord(payload.annotations) ?? {};
    const alertName = cleanText(labels.alertname ?? payload.alertname, "Prometheus alert", 200);
    const status = cleanText(payload.status, "unknown", 50);
    const severity = cleanText(labels.severity ?? payload.severity, status, 50);
    const description = cleanText(
      annotations.description ?? annotations.summary ?? payload.description,
      alertName,
    );
    const tuning = severityConfidence(severity);
    return [
      genericObservation(
        "sensor",
        `${alertName} [${status}/${severity}]: ${description}`,
        envelope.source ?? cleanText(labels.instance ?? labels.job, "prometheus", 200),
        { status, severity, labels: compactObject(labels), annotations: compactObject(annotations) },
        tuning.salience,
        tuning.confidence,
      ),
    ];
  }

  return alerts.map((alert, index) => {
    const labels = asRecord(alert.labels) ?? {};
    const annotations = asRecord(alert.annotations) ?? {};
    const alertName = cleanText(labels.alertname, `Prometheus alert ${index + 1}`, 200);
    const status = cleanText(alert.status ?? payload.status, "unknown", 50);
    const severity = cleanText(labels.severity, status, 50);
    const description = cleanText(
      annotations.description ?? annotations.summary,
      "No description",
    );
    const tuning = severityConfidence(severity);
    return genericObservation(
      "sensor",
      `${alertName} [${status}/${severity}]: ${description}`,
      envelope.source ?? cleanText(labels.instance ?? labels.job, "prometheus", 200),
      {
        status,
        severity,
        startsAt: cleanText(alert.startsAt, "", 100),
        endsAt: cleanText(alert.endsAt, "", 100),
        labels: compactObject(labels),
        annotations: compactObject(annotations),
      },
      tuning.salience,
      tuning.confidence,
    );
  });
}

function normalizeSyslog(envelope: IngestionEnvelope): ObservationInput[] {
  const payload = envelope.payload;
  const severity = cleanText(payload.severity ?? payload.level ?? payload.priority, "info", 50);
  const facility = cleanText(payload.facility, "unknown", 80);
  const host = cleanText(payload.hostname ?? payload.host ?? payload.device, envelope.source ?? "syslog", 200);
  const app = cleanText(payload.app ?? payload.program ?? payload.process, "unknown", 100);
  const message = cleanText(payload.message ?? payload.msg ?? payload.event, "Empty syslog event");
  const tuning = severityConfidence(severity);
  return [
    genericObservation(
      "log",
      `${host} ${app} [${facility}/${severity}]: ${message}`,
      host,
      {
        severity,
        facility,
        app,
        procid: cleanText(payload.procid ?? payload.pid, "", 80),
        messageId: cleanText(payload.msgid ?? payload.messageId, "", 100),
        structuredData: asRecord(payload.structuredData)
          ? compactObject(asRecord(payload.structuredData) ?? {})
          : undefined,
      },
      tuning.salience,
      tuning.confidence,
    ),
  ];
}

function normalizeVision(envelope: IngestionEnvelope): ObservationInput[] {
  const payload = envelope.payload;
  const caption = cleanText(payload.caption ?? payload.summary ?? payload.description, "Visual event");
  const objects = stringList(payload.objects ?? payload.labels ?? payload.detectedObjects);
  const events = stringList(payload.events ?? payload.activities);
  const confidence = cleanNumber(payload.confidence) ?? 0.74;
  const alarm = cleanBoolean(payload.alarm) ?? events.some((event) => /alarm|fire|smoke|intrusion|fall/u.test(event.toLocaleLowerCase()));
  const detail = [objects.length > 0 ? `objects=${objects.join(", ")}` : "", events.length > 0 ? `events=${events.join(", ")}` : ""]
    .filter(Boolean)
    .join("; ");
  return [
    genericObservation(
      "vision",
      detail ? `${caption} (${detail})` : caption,
      envelope.source ?? cleanText(payload.cameraId ?? payload.streamId, "vision", 200),
      {
        objects,
        events,
        alarm,
        frameTimestamp: cleanText(payload.timestamp ?? payload.frameTimestamp, "", 100),
      },
      alarm ? 0.94 : 0.68,
      confidence,
    ),
  ];
}

function normalizeAudio(envelope: IngestionEnvelope): ObservationInput[] {
  const payload = envelope.payload;
  const transcript = cleanText(payload.transcript ?? payload.text ?? payload.utterance, "Empty audio transcript");
  const speaker = cleanText(payload.speaker ?? payload.speakerId, "unknown", 100);
  const language = cleanText(payload.language ?? payload.locale, "unknown", 50);
  const confidence = cleanNumber(payload.confidence) ?? 0.72;
  const wakeWord = cleanBoolean(payload.wakeWordDetected) ?? false;
  return [
    genericObservation(
      "audio",
      `${speaker}: ${transcript}`,
      envelope.source ?? cleanText(payload.microphone ?? payload.device, "audio", 200),
      {
        speaker,
        language,
        wakeWordDetected: wakeWord,
        durationMs: cleanNumber(payload.durationMs),
      },
      wakeWord ? 0.78 : 0.62,
      confidence,
    ),
  ];
}

function normalizeSensor(envelope: IngestionEnvelope): ObservationInput[] {
  const payload = envelope.payload;
  const readings = asRecordArray(payload.readings ?? payload.metrics ?? payload.values);
  const source = envelope.source ?? cleanText(payload.device ?? payload.sensor ?? payload.host, "sensor", 200);
  if (readings.length === 0) {
    const name = cleanText(payload.name ?? payload.metric ?? payload.type, "sensor-value", 100);
    const value = cleanNumber(payload.value);
    const unit = cleanText(payload.unit, "", 30);
    const status = cleanText(payload.status ?? payload.state, "normal", 50);
    const tuning = severityConfidence(status);
    return [
      genericObservation(
        "sensor",
        `${name}=${value ?? cleanText(payload.value, "unknown", 100)}${unit ? ` ${unit}` : ""} (${status})`,
        source,
        { name, value, unit, status, threshold: cleanNumber(payload.threshold) },
        tuning.salience,
        0.86,
      ),
    ];
  }

  return readings.map((reading, index) => {
    const name = cleanText(reading.name ?? reading.metric ?? reading.type, `metric-${index + 1}`, 100);
    const value = cleanNumber(reading.value);
    const unit = cleanText(reading.unit, "", 30);
    const status = cleanText(reading.status ?? reading.state, "normal", 50);
    const tuning = severityConfidence(status);
    return genericObservation(
      "sensor",
      `${name}=${value ?? cleanText(reading.value, "unknown", 100)}${unit ? ` ${unit}` : ""} (${status})`,
      source,
      {
        name,
        value,
        unit,
        status,
        threshold: cleanNumber(reading.threshold),
        min: cleanNumber(reading.min),
        max: cleanNumber(reading.max),
      },
      tuning.salience,
      0.86,
    );
  });
}

function normalizeWebhook(envelope: IngestionEnvelope): ObservationInput[] {
  const payload = envelope.payload;
  const event = cleanText(payload.event ?? payload.type ?? payload.action, "webhook", 100);
  const title = cleanText(payload.title ?? payload.name ?? payload.subject, event, 200);
  const description = cleanText(payload.description ?? payload.message ?? payload.summary, "No description");
  const severity = cleanText(payload.severity ?? payload.level ?? payload.status, "info", 50);
  const tuning = severityConfidence(severity);
  return [
    genericObservation(
      "api",
      `${title} [${event}/${severity}]: ${description}`,
      envelope.source ?? cleanText(payload.source ?? payload.service, "webhook", 200),
      { event, severity, payload: compactObject(payload) },
      tuning.salience,
      tuning.confidence,
    ),
  ];
}

function normalizeGeneric(envelope: IngestionEnvelope): ObservationInput[] {
  const payload = envelope.payload;
  const summary = cleanText(
    payload.summary ?? payload.message ?? payload.description ?? payload.event,
    "Generic cognitive event",
  );
  const modalityValue = cleanText(payload.modality, "api", 30) as CognitiveModality;
  const allowed: CognitiveModality[] = [
    "text",
    "audio",
    "vision",
    "sensor",
    "api",
    "log",
    "tool",
    "internal",
  ];
  const modality = allowed.includes(modalityValue) ? modalityValue : "api";
  return [
    genericObservation(
      modality,
      summary,
      envelope.source ?? cleanText(payload.source, "generic", 200),
      payload,
      cleanNumber(payload.salience),
      cleanNumber(payload.confidence),
    ),
  ];
}

export function normalizeIngestion(envelope: IngestionEnvelope): ObservationInput[] {
  switch (envelope.kind) {
    case "prometheus_alert":
      return normalizePrometheus(envelope);
    case "syslog":
      return normalizeSyslog(envelope);
    case "vision":
      return normalizeVision(envelope);
    case "audio":
      return normalizeAudio(envelope);
    case "sensor":
      return normalizeSensor(envelope);
    case "webhook":
      return normalizeWebhook(envelope);
    case "generic":
    default:
      return normalizeGeneric(envelope);
  }
}

export function parseIngestionPayload(value: string, maxChars = 250_000): Record<string, unknown> {
  if (value.length > maxChars) {
    throw new Error(`payloadJson exceeds the ${maxChars} character limit`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("payloadJson must be valid JSON");
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new Error("payloadJson must contain a JSON object");
  }
  return record;
}
