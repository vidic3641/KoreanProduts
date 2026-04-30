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
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method not allowed" });
  }

  if (req.headers.authorization !== `Bearer ${process.env.ADMIN_SECRET}`) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const { action, targetVersion, products, totalCount } = req.body;

    const firebaseAdmin = getFirebaseAdmin();
    const db = firebaseAdmin.database();

    if (action === "start") {
      const activeSnap = await db.ref("active_version").get();
      const activeVersion = activeSnap.exists() ? activeSnap.val() : "current";

      const nextTarget = activeVersion === "current" ? "next" : "current";
      const targetPath = `products_${nextTarget}`;

      await db.ref(targetPath).remove();

      return res.status(200).json({
        ok: true,
        activeVersion,
        targetVersion: nextTarget,
        targetPath,
        totalCount,
      });
    }

    if (action === "upload") {
      if (!targetVersion || !["current", "next"].includes(targetVersion)) {
        return res.status(400).json({ error: "invalid targetVersion" });
      }

      if (!products || typeof products !== "object") {
        return res.status(400).json({ error: "invalid products" });
      }

      const targetPath = `products_${targetVersion}`;

      await db.ref(targetPath).update(products);

      return res.status(200).json({
        ok: true,
        targetPath,
        uploaded: Object.keys(products).length,
      });
    }

    if (action === "finish") {
      if (!targetVersion || !["current", "next"].includes(targetVersion)) {
        return res.status(400).json({ error: "invalid targetVersion" });
      }

      const targetPath = `products_${targetVersion}`;
      const snap = await db.ref(targetPath).get();

      if (!snap.exists()) {
        return res.status(400).json({ error: "target database is empty" });
      }

      const count = snap.numChildren();

      if (Number(totalCount) && count !== Number(totalCount)) {
        return res.status(400).json({
          error: "count mismatch",
          expected: Number(totalCount),
          actual: count,
        });
      }

      await db.ref("active_version").set(targetVersion);

      return res.status(200).json({
        ok: true,
        activeVersion: targetVersion,
        count,
      });
    }

    return res.status(400).json({ error: "invalid action" });

  } catch (e) {
    return res.status(500).json({
      error: "server error",
      message: e.message,
    });
  }
}
