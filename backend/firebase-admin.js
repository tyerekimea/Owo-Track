const admin = require("firebase-admin");

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is required for the Firebase backend.");
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid JSON.");
  }
}

const app = admin.apps.length
  ? admin.app()
  : admin.initializeApp({
      credential: admin.credential.cert(getServiceAccount()),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });

const firestore = admin.firestore(app);
const storage = admin.storage(app).bucket();
const auth = admin.auth(app);

module.exports = { admin, app, auth, firestore, storage };
