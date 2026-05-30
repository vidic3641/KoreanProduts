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

function getPrivateKey() {
  const key = process.env.FEEDBACK_GOOGLE_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY || "";
  return key.replace(/\\n/g, "\n");
}

function createJwt() {
  const clientEmail = process.env.FEEDBACK_GOOGLE_CLIENT_EMAIL || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
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

function cleanText(value, maxLength = 2000) {
  return String(value || "").trim().slice(0, maxLength);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  try {
    const sheetId = process.env.FEEDBACK_SHEET_ID;
    const sheetRange = process.env.FEEDBACK_SHEET_RANGE || "Feedback!A:H";

    if (!sheetId) {
      return res.status(500).json({ error: "feedback sheet is not configured", code: "missing_sheet_id" });
    }

    const body = req.body || {};
    const message = cleanText(body.message);

    if (!message) {
      return res.status(400).json({ error: "message is required" });
    }

    const row = [
      new Date().toISOString(),
      cleanText(body.type, 80) || "feedback",
      message,
      cleanText(body.lang, 20),
      cleanText(body.barcode, 40),
      cleanText(body.url, 500),
      cleanText(body.path, 200),
      cleanText(body.userAgent, 500)
    ];

    const accessToken = await getAccessToken();
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
      console.error("Google Sheets append failed", response.status, errorText);
      const error = new Error("Failed to append feedback to Google Sheets");
      error.code = "sheet_append_failed";
      error.status = response.status;
      throw error;
    }

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("feedback error", error);
    return res.status(500).json({
      error: "server error",
      code: error.code || "unknown_error",
      status: error.status || null
    });
  }
}
