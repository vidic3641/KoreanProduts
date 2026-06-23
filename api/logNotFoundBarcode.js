import crypto from "crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getClientEmail() {
  return process.env.NOT_FOUND_GOOGLE_CLIENT_EMAIL ||
    process.env.REPORT_GOOGLE_CLIENT_EMAIL ||
    process.env.FEEDBACK_GOOGLE_CLIENT_EMAIL ||
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
}

function getPrivateKey() {
  const key = process.env.NOT_FOUND_GOOGLE_PRIVATE_KEY ||
    process.env.REPORT_GOOGLE_PRIVATE_KEY ||
    process.env.FEEDBACK_GOOGLE_PRIVATE_KEY ||
    process.env.GOOGLE_PRIVATE_KEY ||
    "";

  return key.replace(/\\n/g, "\n");
}

function createJwt() {
  const clientEmail = getClientEmail();
  const privateKey = getPrivateKey();

  if (!clientEmail || !privateKey) {
    const error = new Error("Google service account credentials are missing");
    error.code = "missing_credentials";
    throw error;
  }

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iss: clientEmail,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now
  };

  const unsignedToken = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsignedToken).sign(privateKey);

  return `${unsignedToken}.${base64Url(signature)}`;
}

async function getAccessToken() {
  const jwt = createJwt();
  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Google token failed", response.status, errorText);
    const error = new Error("Failed to get Google access token");
    error.code = "token_failed";
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  return data.access_token;
}

function cleanText(value, maxLength = 1000) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanBarcode(value) {
  return cleanText(value, 40).replace(/[^0-9a-zA-Z_-]/g, "");
}

async function appendNotFoundBarcode({ accessToken, sheetId, sheetRange, row }) {
  const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(sheetId)}/values/${encodeURIComponent(sheetRange)}:append?valueInputOption=USER_ENTERED`;
  const response = await fetch(appendUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ values: [row] })
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Not-found barcode sheet append failed", response.status, errorText);
    const error = new Error("Failed to append not-found barcode to Google Sheets");
    error.code = "sheet_append_failed";
    error.status = response.status;
    throw error;
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "logNotFoundBarcode",
      env: {
        clientEmail: Boolean(getClientEmail()),
        privateKey: Boolean(getPrivateKey()),
        sheetId: Boolean(process.env.NOT_FOUND_SHEET_ID || process.env.REPORT_SHEET_ID || process.env.FEEDBACK_SHEET_ID),
        sheetRange: process.env.NOT_FOUND_SHEET_RANGE || "NotFoundBarcodes!A:M"
      }
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  try {
    const sheetId = process.env.NOT_FOUND_SHEET_ID || process.env.REPORT_SHEET_ID || process.env.FEEDBACK_SHEET_ID;
    const sheetRange = process.env.NOT_FOUND_SHEET_RANGE || "NotFoundBarcodes!A:M";

    if (!sheetId) {
      return res.status(500).json({ error: "not-found barcode sheet is not configured", code: "missing_sheet_id" });
    }

    const body = req.body || {};
    const barcode = cleanBarcode(body.barcode);

    if (!barcode) {
      return res.status(400).json({ error: "barcode is required", code: "missing_barcode" });
    }

    const candidates = Array.isArray(body.candidates)
      ? body.candidates.map(candidate => cleanText(candidate, 40)).filter(Boolean).join(",")
      : cleanText(body.candidates, 300);

    const row = [
      new Date().toISOString(),
      "not_found_barcode",
      barcode,
      cleanText(body.lang, 20),
      cleanText(body.source, 80),
      cleanText(body.utm_source, 120),
      cleanText(body.utm_medium, 120),
      cleanText(body.utm_campaign, 120),
      candidates,
      cleanText(body.url, 500),
      cleanText(body.path, 200),
      cleanText(body.referrer, 500),
      cleanText(body.userAgent, 500)
    ];

    const accessToken = await getAccessToken();
    await appendNotFoundBarcode({ accessToken, sheetId, sheetRange, row });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("not-found barcode log error", error);
    return res.status(500).json({
      error: "server error",
      code: error.code || "unknown_error",
      status: error.status || null
    });
  }
}
