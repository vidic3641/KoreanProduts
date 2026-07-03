const APPS_SCRIPT_URL = process.env.COLLECTOR_APPS_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbybYFR-z96oJvnFk8CAeuqpPI3rqppVChZXvFeDlI5QxUyS423Fqq0nwE0fM1CQKWCImg/exec";

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  try {
    const requestUrl = new URL(req.url, `https://${req.headers.host || "localhost"}`);
    const adminKey = requestUrl.searchParams.get("key") || "";
    const sourceUrl = new URL(APPS_SCRIPT_URL);
    sourceUrl.searchParams.set("action", "barcodes");
    if (adminKey) sourceUrl.searchParams.set("key", adminKey);

    const response = await fetchWithTimeout(sourceUrl.toString(), {
      method: "GET",
      redirect: "follow",
      headers: { Accept: "application/json" }
    });
    const text = await response.text();
    const data = parseJson(text);

    if (!response.ok) {
      return sendJson(res, 502, {
        ok: false,
        error: "apps_script_http_error",
        status: response.status,
        detail: safePreview(text)
      });
    }

    if (!data) {
      return sendJson(res, 502, {
        ok: false,
        error: "apps_script_invalid_json",
        detail: safePreview(text)
      });
    }

    if (data.ok === false) {
      const status = data.error === "unauthorized" ? 401 : 502;
      return sendJson(res, status, data);
    }

    const barcodes = Array.isArray(data) ? data : data.barcodes;
    if (!Array.isArray(barcodes)) {
      return sendJson(res, 502, { ok: false, error: "barcodes_array_missing" });
    }

    return sendJson(res, 200, {
      ok: true,
      count: barcodes.length,
      barcodes
    });
  } catch (error) {
    return sendJson(res, 502, {
      ok: false,
      error: "barcode_list_proxy_failed",
      detail: error.message || String(error)
    });
  }
};

async function fetchWithTimeout(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function safePreview(text) {
  return String(text || "").slice(0, 240);
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}
