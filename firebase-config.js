/* ============================================================
   إعدادات Firebase  —  ضع هنا إعدادات مشروعك الخاص
   ------------------------------------------------------------
   كيف تحصل عليها:
   1) افتح https://console.firebase.google.com وأنشئ مشروعاً.
   2) Project settings ⚙ → General → Your apps → Web app (</>).
   3) انسخ كائن firebaseConfig والصق قيمه مكان القيم أدناه.
   4) فعّل: Build → Firestore Database  (Create database).
   5) فعّل: Build → Authentication → Sign-in method → Email/Password،
      ثم Users → Add user (بريدك وكلمة مرورك للدخول من كل الأجهزة).
   6) اضبط قواعد Firestore (انظر ملاحظة الأمان في README-firebase.txt).
   ============================================================ */

const firebaseConfig = {
  apiKey: "AIzaSyBy--RXZyDNow3ghfWJTCRwBwZMCRWndtQ",
  authDomain: "rooh-almonafsa-est.firebaseapp.com",
  projectId: "rooh-almonafsa-est",
  storageBucket: "rooh-almonafsa-est.appspot.com",
  messagingSenderId: "36431700807",
  appId: "1:36431700807:web:497bdc7d43b7cf4320e262"
};

/* تهيئة Firebase (compat SDK) */
firebase.initializeApp(firebaseConfig);

/* كائنات عامة يستخدمها app.js */
const auth = firebase.auth();
const db = firebase.firestore();

/* تفعيل العمل دون إنترنت (تخزين محلي + تزامن عند عودة الاتصال) */
firebase.firestore().enablePersistence({ synchronizeTabs: true }).catch(function (err) {
  console.warn('offline persistence غير مفعّل:', err && err.code);
});
