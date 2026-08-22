import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

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

const app = getApps().length
  ? getApps()[0]
  : initializeApp({
      credential: cert(getServiceAccount()),
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    });

const firestore = getFirestore(app);
const storage = getStorage(app).bucket();
const auth = getAuth(app);

export { app, auth, firestore, storage };
