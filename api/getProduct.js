import admin from "firebase-admin";

function getFirebaseAdmin() {
  if (admin.apps.length) return admin;

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });

  return admin;
}

export default async function handler(req, res) {
  try {
    const { barcode } = req.query;

    if (!barcode) {
      return res.status(400).json({
        error: "invalid barcode",
        barcode: ""
      });
    }

    const cleanBarcode = String(barcode).trim().replace(/[\.\#\$\/\[\]]/g, "");

    const firebaseAdmin = getFirebaseAdmin();
    const db = firebaseAdmin.database();

    const activeSnap = await db.ref("active_version").get();
    const activeVersion = activeSnap.exists() ? activeSnap.val() : "current";

    const productPath = `products_${activeVersion}/${cleanBarcode}`;
    const productSnap = await db.ref(productPath).get();

    if (!productSnap.exists()) {
      return res.status(404).json({
        error: "not found",
        barcode: cleanBarcode,
        path: productPath
      });
    }

    return res.status(200).json(productSnap.val());

  } catch (e) {
    return res.status(500).json({
      error: "server error"
    });
  }
}
