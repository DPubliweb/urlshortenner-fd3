const { initializeApp } = require('firebase/app');
const { getFunctions, httpsCallable } = require('firebase/functions');



const firebaseConfig = {
  apiKey: "AIzaSyDAACQBBPIeYCkgwqSM7GQQGnkhUPTk_dc",
  authDomain: "url-shortener-aud.firebaseapp.com",
  projectId: "url-shortener-aud",
  storageBucket: "url-shortener-aud.appspot.com",
  messagingSenderId: "846887909877",
  appId: "1:846887909877:web:b8e842df95800029f988bc",
  measurementId: "G-QWNLS98DQP"
};


const app = initializeApp(firebaseConfig);
const functions = getFunctions(app, 'us-central1');

// Reference to your callable function
const deleteDocsBeforeDate = httpsCallable(functions, 'deleteDocsBeforeDate');

// Now you can call your function
deleteDocsBeforeDate({ cutoffDate: '2023-08-01T00:00:00Z' })
  .then((result) => {
    // Read result of the Cloud Function.
    console.log(result.data);
  })
  .catch((error) => {
    // Getting the Error details.
    console.error('Error when calling the function:', error);
  });