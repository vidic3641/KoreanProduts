const APPS_SCRIPT_URL = process.env.COLLECTOR_APPS_SCRIPT_URL || "https://script.google.com/macros/s/AKfycbybYFR-z96oJvnFk8CAeuqpPI3rqppVChZXvFeDlI5QxUyS423Fqq0nwE0fM1CQKWCImg/exec";
const MAX_BODY_BYTES = 6 * 1024 * 1024;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "method_not_allowed" });
  }

  try {
    const bodyText = await getBodyText(req);
    if (!bodyText) {
      return sendJson(res, 400, { ok: false, error: "empty_body" });
    }

    const response = await fetchWithTimeout(APPS_SCRIPT_URL, {
      method: "POST",
      redirect: "follow",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: bodyText
    }, 30000);

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

    return sendJson(res, 200, data);
  } catch (error) {
    const message = error.message || String(error);
    const status = message === "body_too_large" ? 413 : 502;
    return sendJson(res, status, {
      ok: false,
      error: status === 413 ? "body_too_large" : "upload_proxy_failed",
      detail: message
    });
  }
};

module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: "6mb"
    }
  }
};

async function getBodyText(req) {
  if (req.body) {
    return typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }

  return await new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];

    req.on("data", chunk => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error("body_too_large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function fetchWithTimeout(url, options, timeoutMs) {
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