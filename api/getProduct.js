import admin from "firebase-admin";

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: "scan-korea",
      clientEmail: "firebase-adminsdk-fbsvc@scan-korea.iam.gserviceaccount.com",
      privateKey: "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDYBY1OU+egmBv5\nRRrOeiRNFwmv6WL9TyzwV7xi16/Gr0xGkXkShx1CzX5XAA8TYqRvOGvcgMA+j2wC\nWphcBEjIOSL2Xu5C92PESXHVu3rXGbwqOne7riEFEkOw+Jd7WgC8+IkJLRFOCB/p\n7oTYA8Cy0nJiG6VCVPmfIf0AkfMoVMqaqlXeq4gTIffAh+F+RpWfrj+CnxVG11vt\nIdQVRIYopVwAbrgxZ1R6gzzVoke1wHaWVARqQTYYXJRFOFbwiMsEVql/0FD8ifko\nA0s3ZoTW0PMuqPVKSewARkqnB7eZXHBZrMUga+l/I6eMzP8mnLZowbObNNvkvpj8\n2xGlFo59AgMBAAECggEAC6cfBIDnr4TNC4EEDWvOzf7GZcAd+CKffraI4b8XSw01\nPOBHiu2RcUNTA5/r8ESDsME3Jk2msSk87xKSgfI0N+LHJUmhKikcr1+z3Y7vtS88\n9H0zbMMbomGmF6ONTljgTdFNWRqegppTGGQms91d9Xd/NpYdr8qULZaghnmZB42U\nAf0FRqWlGSlgzJCC39L/D5Nr2pep8F9e6AgyIiuOxaHHtt8UJ+HJ8lWoEmDvZ+4W\nXNnYPKfc9A/sqvOSkHYZ0qt4VV2umVqYFer7tHPkPI8vUYtOE+efnt47ztG50Bsl\n5W0AYAt/J1BlK4S6mhQY8douS2CVeUMtMXbFH9reSQKBgQDtfWyETQNhqaslbkM7\nVLcn8ZPrxzgQfaaH/PRU9AKDjRoD5MfpP5//HQnKSyWctSUbuknx01XsRrD16T/e\n8VbMmyxqlY0koiiPu7eKBA4NfFth9428EL5lh53jCu4p5c2B+udJwZF6kDoNsmJk\nips908yoQ6TUYBCdA1iWz6T0yQKBgQDo28cPMujQ0Ke4vtRuPBuFUWDq0mkZKu01\nqtWXuVlCVfzBQnZOs/EFFfVj1qW992SI5qIGrW62B0Pn3jUBXOeRezFg1ajczd27\nbjW7aYEBDSCUqAtfzlcdOAVs37/uo5ywhhAsPLzWiNeSOEWOQjwWjj/2ro7mT0gn\n62RG53mqFQKBgQC7a6ggIMbyY/v05jeYsxp4I2YhRG8yVHcACtin0onJV6mYOQyr\nPtL9eeUoCHX+XdaTM0j311iPxpoQ96q4Pq3JewxqcOuaZX6tL++AtAKDEgjsH3lz\nWaNobMZlT1L1La4pTeEJjAFLQFcQSB7uSZSKDoQMppWGJOn3f5SCMAx2QQKBgQCB\n81UNuF2RW0Ceq3Cl7El3h0jNA4u/jeM/lg0JVVjo2k/qEosvtOAG9JAznXB1qYCj\nngJCM7ubPka5OZrfHdflqpiN7+8C+qiJlyHJa0GhMpBCJd3jI6YeGkt8zQmxxgEF\nymtwJJ1GJKwZX+oBUBl0hQJRSm1ZPlmIXadion+VWQKBgD/e6psBy9Eu/m589Efm\n2uSLDRsMCq3ZelZH/1z3UzXYxbmDl82xylTgA/tWxbXgRM6Xgada4CmWM5UBHHTY\neSXYX+tITs3cAEa1zb0i2/v+8X49vV1gtHKyN4pXmB6sP/gKpr0FbW59eCwrFVu3\nK87l2+K2J/FSSY3gDq+QB8Tu\n-----END PRIVATE KEY-----\n".replace(/\\n/g, '\n')
    }),
    databaseURL: "https://scan-korea.firebaseio.com"
  });
}

export default async function handler(req, res) {
  const { barcode, lang = "ko" } = req.query;

  if (!/^[0-9]{8,13}$/.test(barcode)) {
    return res.status(400).json({ error: "invalid" });
  }

  try {
    const baseRef = admin.database().ref(`products/${barcode}`);

    const [commonSnap, langSnap] = await Promise.all([
      baseRef.child("common").once("value"),
      baseRef.child(lang).once("value")
    ]);

    const data = {
      ...commonSnap.val(),
      ...langSnap.val()
    };

    if (!data) {
      return res.status(404).json({ error: "not found" });
    }

    res.status(200).json(data);

  } catch (e) {
    res.status(500).json({ error: "server error" });
  }
}
