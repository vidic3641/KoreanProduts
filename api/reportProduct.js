import crypto from "crypto";
import admin from "firebase-admin";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function getFirebasePrivateKey() {
  const key = process.env.FIREBASE_PRIVATE_KEY || process.env.FEEDBACK_GOOGLE_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY || "";
  return key.replace(/\\n/g, "\n");
}

function getGooglePrivateKey() {
  const key = process.env.REPORT_GOOGLE_PRIVATE_KEY || process.env.FEEDBACK_GOOGLE_PRIVATE_KEY || process.env.GOOGLE_PRIVATE_KEY || "";
  return key.replace(/\\n/g, "\n");
}

function getFirebaseClientEmail() {
  return process.env.FIREBASE_CLIENT_EMAIL || process.env.FEEDBACK_GOOGLE_CLIENT_EMAIL || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
}

function getGoogleClientEmail() {
  return process.env.REPORT_GOOGLE_CLIENT_EMAIL || process.env.FEEDBACK_GOOGLE_CLIENT_EMAIL || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
}

function initFirebase() {
  if (admin.apps.length) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = getFirebaseClientEmail();
  const privateKey = getFirebasePrivateKey();
  const storageBucket = process.env.FIREBASE_STORAGE_BUCKET;

  if (!projectId || !clientEmail || !privateKey || !storageBucket) {
    const error = new Error("Firebase credentials or storage bucket are missing");
    error.code = "missing_firebase_config";
    throw error;
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey
    }),
    storageBucket
  });
}

function base64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createJwt() {
  const clientEmail = getGoogleClientEmail();
  const privateKey = getGooglePrivateKey();

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

function makeDownloadUrl(bucketName, filePath, token) {
  return `https://firebasestorage.googleapis.com/v0/b/${encodeURIComponent(bucketName)}/o/${encodeURIComponent(filePath)}?alt=media&token=${encodeURIComponent(token)}`;
}

async function uploadImage({ dataUrl, filePath }) {
  initFirebase();

  const bucketName = process.env.FIREBASE_STORAGE_BUCKET;
  const { mimeType, buffer } = parseDataUrl(dataUrl);
  const token = crypto.randomUUID();
  const file = admin.storage().bucket().file(filePath);

  await file.save(buffer, {
    contentType: mimeType,
    resumable: false,
    metadata: {
      metadata: {
        firebaseStorageDownloadTokens: token
      }
    }
  });

  return makeDownloadUrl(bucketName, filePath, token);
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
        firebaseProjectId: Boolean(process.env.FIREBASE_PROJECT_ID),
        firebaseClientEmail: Boolean(getFirebaseClientEmail()),
        firebasePrivateKey: Boolean(getFirebasePrivateKey()),
        storageBucket: Boolean(process.env.FIREBASE_STORAGE_BUCKET),
        sheetId: Boolean(process.env.REPORT_SHEET_ID || process.env.FEEDBACK_SHEET_ID),
        sheetRange: process.env.REPORT_SHEET_RANGE || "ProductReports!A:K"
      }
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  }

  if (process.env.REPORT_UPLOAD_ENABLED === "false") {
    return res.status(503).json({ error: "product report upload is disabled", code: "upload_disabled" });
  }

  try {
    const sheetId = process.env.REPORT_SHEET_ID || process.env.FEEDBACK_SHEET_ID;
    const sheetRange = process.env.REPORT_SHEET_RANGE || "ProductReports!A:K";

    if (!sheetId) return res.status(500).json({ error: "report sheet is not configured", code: "missing_sheet_id" });
    if (!process.env.FIREBASE_STORAGE_BUCKET) return res.status(500).json({ error: "storage bucket is not configured", code: "missing_storage_bucket" });

    const body = req.body || {};
    const barcode = cleanText(body.barcode, 40);
    const productPhoto = body.productPhoto || {};
    const barcodePhoto = body.barcodePhoto || {};

    if (!barcode) return res.status(400).json({ error: "barcode is required", code: "missing_barcode" });
    if (!productPhoto.dataUrl || !barcodePhoto.dataUrl) {
      return res.status(400).json({ error: "two photos are required", code: "missing_photos" });
    }

    const safeBarcode = barcode.replace(/[^0-9a-zA-Z_-]/g, "") || "unknown";
    const timestamp = new Date().toISOString();
    const reportId = `${Date.now()}_${crypto.randomUUID()}`;
    const productPhotoUrl = await uploadImage({
      dataUrl: productPhoto.dataUrl,
      filePath: `product-reports/${safeBarcode}/${reportId}_product.jpg`
    });
    const barcodePhotoUrl = await uploadImage({
      dataUrl: barcodePhoto.dataUrl,
      filePath: `product-reports/${safeBarcode}/${reportId}_barcode.jpg`
    });
    const accessToken = await getAccessToken();

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
        cleanText(body.userAgent, 500),
        "new",
        ""
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
