import crypto from "crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/spreadsheets"
].join(" ");

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function getPrivateKey() {
  const key = process.env.REPORT_GOOGLE_PRIVATE_KEY || process.env.FEEDBACK_GOOGLE_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY || "";
  return key.replace(/\\n/g, "\n");
}

function createJwt() {
  const clientEmail =
    process.env.REPORT_GOOGLE_CLIENT_EMAIL ||
    process.env.FEEDBACK_GOOGLE_CLIENT_EMAIL ||
    process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
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
    scope: SCOPES,
    aud: TOKEN_URL,
    exp: now + 3600,
    iat: now
  };

  const unsignedToken = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(payload))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsignedToken).sign(privateKey);

  return `${unsignedToken}.${base64Url(signature)}`;
}

async function getAccessToken() {
  const params = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: createJwt()
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

function parseDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);

  if (!match) {
    const error = new Error("Invalid image data");
    error.code = "invalid_image";
    throw error;
  }

  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64")
  };
}

async function uploadImage({ accessToken, folderId, dataUrl, filename }) {
  const { mimeType, buffer } = parseDataUrl(dataUrl);
  const boundary = `scankorea_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  const metadata = {
    name: filename,
    mimeType,
    parents: [folderId]
  };
  const delimiter = `--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;
  const body = Buffer.concat([
    Buffer.from(`${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`),
    Buffer.from(`${delimiter}Content-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(closeDelimiter)
  ]);

  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": `multipart/related; boundary=${boundary}`
    },
    body
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Drive upload failed", response.status, errorText);
    const error = new Error("Failed to upload image to Google Drive");
    error.code = "drive_upload_failed";
    error.status = response.status;
    throw error;
  }

  const file = await response.json();
  return file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`;
}

async function appendReport({ accessToken, sheetId, sheetRange, row }) {
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
    console.error("Product report sheet append failed", response.status, errorText);
    const error = new Error("Failed to append product report");
    error.code = "sheet_append_failed";
    error.status = response.status;
    throw error;
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      route: "reportProduct",
      env: {
        clientEmail: Boolean(process.env.REPORT_GOOGLE_CLIENT_EMAIL || process.env.FEEDBACK_GOOGLE_CLIENT_EMAIL || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL),
        privateKey: Boolean(process.env.REPORT_GOOGLE_PRIVATE_KEY || process.env.FEEDBACK_GOOGLE_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY),
        sheetId: Boolean(process.env.REPORT_SHEET_ID || process.env.FEEDBACK_SHEET_ID),
        driveFolderId: Boolean(process.env.REPORT_DRIVE_FOLDER_ID),
        sheetRange: process.env.REPORT_SHEET_RANGE || "ProductReports!A:I"
      }
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  try {
    const sheetId = process.env.REPORT_SHEET_ID || process.env.FEEDBACK_SHEET_ID;
    const sheetRange = process.env.REPORT_SHEET_RANGE || "ProductReports!A:I";
    const folderId = process.env.REPORT_DRIVE_FOLDER_ID;

    if (!sheetId) return res.status(500).json({ error: "report sheet is not configured", code: "missing_sheet_id" });
    if (!folderId) return res.status(500).json({ error: "drive folder is not configured", code: "missing_drive_folder_id" });

    const body = req.body || {};
    const barcode = cleanText(body.barcode, 40);
    const productPhoto = body.productPhoto || {};
    const barcodePhoto = body.barcodePhoto || {};

    if (!barcode) return res.status(400).json({ error: "barcode is required", code: "missing_barcode" });
    if (!productPhoto.dataUrl || !barcodePhoto.dataUrl) {
      return res.status(400).json({ error: "two photos are required", code: "missing_photos" });
    }

    const accessToken = await getAccessToken();
    const safeBarcode = barcode.replace(/[^0-9a-zA-Z_-]/g, "");
    const timestamp = new Date().toISOString();
    const productPhotoUrl = await uploadImage({
      accessToken,
      folderId,
      dataUrl: productPhoto.dataUrl,
      filename: `${safeBarcode || "unknown"}_product_${Date.now()}_${cleanText(productPhoto.name, 80) || "photo"}`
    });
    const barcodePhotoUrl = await uploadImage({
      accessToken,
      folderId,
      dataUrl: barcodePhoto.dataUrl,
      filename: `${safeBarcode || "unknown"}_barcode_${Date.now()}_${cleanText(barcodePhoto.name, 80) || "photo"}`
    });

    await appendReport({
      accessToken,
      sheetId,
      sheetRange,
      row: [
        timestamp,
        "missing_product",
        barcode,
        productPhotoUrl,
        barcodePhotoUrl,
        cleanText(body.message),
        cleanText(body.lang, 20),
        cleanText(body.url, 500),
        cleanText(body.userAgent, 500)
      ]
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("product report error", error);
    return res.status(500).json({
      error: "server error",
      code: error.code || "unknown_error",
      status: error.status || null
    });
  }
}
