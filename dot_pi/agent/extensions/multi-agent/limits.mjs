const TRUNCATION_SUFFIX = "...[truncated]";

function utf8Head(value, maxBytes) {
  return Buffer.from(value, "utf8")
    .subarray(0, Math.max(0, maxBytes))
    .toString("utf8")
    .replace(/\uFFFD+$/u, "");
}

function utf8Tail(value, maxBytes) {
  const buffer = Buffer.from(value, "utf8");
  return buffer
    .subarray(Math.max(0, buffer.length - Math.max(0, maxBytes)))
    .toString("utf8")
    .replace(/^\uFFFD+/u, "");
}

export function truncateUtf8(value, maxBytes, options = {}) {
  if (typeof value !== "string") return value;
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= maxBytes) return value;

  const tailBytes = Math.min(
    Math.max(0, options.tailBytes ?? 0),
    Math.floor(maxBytes / 2),
  );
  let marker = options.marker ?? TRUNCATION_SUFFIX;
  let markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= maxBytes) return utf8Head(marker, maxBytes);
  const contentBytes = maxBytes - markerBytes;
  const tail =
    tailBytes > 0 ? utf8Tail(value, Math.min(tailBytes, contentBytes)) : "";
  const actualTailBytes = Buffer.byteLength(tail, "utf8");
  const head = utf8Head(value, contentBytes - actualTailBytes);
  if (options.reportOmitted) {
    const placeholder =
      "\n\n[Content truncated; full data remains in the child session.]\n\n";
    const available = Math.max(
      0,
      maxBytes - Buffer.byteLength(placeholder, "utf8") - 32,
    );
    const adjustedTail =
      tailBytes > 0
        ? utf8Tail(value, Math.min(tailBytes, Math.floor(available / 2)))
        : "";
    const adjustedHead = utf8Head(
      value,
      available - Buffer.byteLength(adjustedTail, "utf8"),
    );
    const adjustedOmitted =
      bytes -
      Buffer.byteLength(adjustedHead, "utf8") -
      Buffer.byteLength(adjustedTail, "utf8");
    marker = `\n\n[Content truncated: ${adjustedOmitted} bytes omitted; full data remains in the child session.]\n\n`;
    if (Buffer.byteLength(marker, "utf8") >= maxBytes) {
      return utf8Head(marker, maxBytes);
    }
    const markerOverflow = Math.max(
      0,
      Buffer.byteLength(`${adjustedHead}${marker}${adjustedTail}`, "utf8") -
        maxBytes,
    );
    return `${utf8Head(adjustedHead, Buffer.byteLength(adjustedHead, "utf8") - markerOverflow)}${marker}${adjustedTail}`;
  }
  return `${head}${marker}${tail}`;
}

export function sanitizeBounded(value, options = {}) {
  const maxDepth = options.maxDepth ?? 4;
  const maxArray = options.maxArray ?? 25;
  const maxKeys = options.maxKeys ?? 40;
  const maxStringBytes = options.maxStringBytes ?? 4096;
  const maxBytes = options.maxBytes ?? 16384;
  let remaining = maxBytes;

  const account = (item) => {
    remaining -= Buffer.byteLength(String(item), "utf8");
  };
  const visit = (item, depth) => {
    if (remaining <= 0) return "[value omitted: byte budget exhausted]";
    if (depth > maxDepth) {
      account(24);
      return "[nested value omitted]";
    }
    if (typeof item === "string") {
      const text = truncateUtf8(item, Math.min(maxStringBytes, remaining));
      account(text);
      return text;
    }
    if (item === null || typeof item !== "object") {
      account(JSON.stringify(item));
      return item;
    }
    if (Array.isArray(item)) {
      const output = [];
      for (const child of item.slice(0, maxArray)) {
        if (remaining <= 0) break;
        output.push(visit(child, depth + 1));
      }
      return output;
    }
    const output = {};
    for (const [key, child] of Object.entries(item).slice(0, maxKeys)) {
      if (remaining <= 0) break;
      const boundedKey = truncateUtf8(key, Math.min(1024, remaining));
      account(JSON.stringify(boundedKey));
      output[boundedKey] = visit(child, depth + 1);
    }
    return output;
  };

  try {
    const sanitized = visit(value, 0);
    const serialized = JSON.stringify(sanitized);
    if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return sanitized;
    const overhead = Buffer.byteLength(
      JSON.stringify({ truncated: true, preview: "" }),
      "utf8",
    );
    if (maxBytes <= overhead) {
      if (maxBytes <= 0) return undefined;
      if (maxBytes < 4) return 0;
      return null;
    }
    let previewBytes = Math.floor((maxBytes - overhead) / 2);
    let reduced = {
      truncated: true,
      preview: truncateUtf8(serialized, previewBytes),
    };
    while (
      previewBytes > 0 &&
      Buffer.byteLength(JSON.stringify(reduced), "utf8") > maxBytes
    ) {
      previewBytes = Math.floor(previewBytes * 0.8);
      reduced = {
        truncated: true,
        preview: truncateUtf8(serialized, previewBytes),
      };
    }
    if (Buffer.byteLength(JSON.stringify(reduced), "utf8") <= maxBytes) {
      return reduced;
    }
    if (maxBytes <= 0) return undefined;
    if (maxBytes < 4) return 0;
    return null;
  } catch {
    if (maxBytes <= 0) return undefined;
    if (maxBytes < 4) return 0;
    return null;
  }
}

export function serializeBoundedActivity(event, maxBytes = 32768) {
  let serialized = JSON.stringify(event);
  if (Buffer.byteLength(serialized, "utf8") <= maxBytes) return serialized;
  const reduced = {
    seq: event.seq,
    timestamp: truncateUtf8(String(event.timestamp ?? ""), 128),
    type: truncateUtf8(String(event.type ?? "unknown"), 256),
    toolCallId:
      event.toolCallId === undefined
        ? undefined
        : truncateUtf8(String(event.toolCallId), 512),
    toolName:
      event.toolName === undefined
        ? undefined
        : truncateUtf8(String(event.toolName), 256),
    summary: truncateUtf8(String(event.summary ?? ""), 4096),
    data: "[activity data omitted: event exceeded byte limit]",
  };
  return JSON.stringify(reduced);
}
