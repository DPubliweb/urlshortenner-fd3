const functions = require('firebase-functions');
const admin = require('firebase-admin');
admin.initializeApp();

exports.deleteDocsBeforeDate = functions.https.onCall(async (data, context) => {
  // Vérifiez les autorisations ici, si nécessaire

  const cutoffDate = new Date(data.cutoffDate);
  const urlsCollectionRef = admin.firestore().collection('urls');
  
  // Taille de chaque lot
  const batchSize = 500; // Taille du lot, à ajuster selon vos besoins
  let deletedCount = 0;

  const query = urlsCollectionRef.orderBy('__name__').limit(batchSize);

  const deleteInBatches = async (query, resolve, reject) => {
    const snapshot = await query.get();

    // Si il n'y a plus de documents, on a fini
    if (snapshot.size === 0) {
      resolve(deletedCount);
      return;
    }

    // Prépare le lot pour la suppression
    const batch = admin.firestore().batch();
    snapshot.docs.forEach((doc) => {
      const url = doc.data().url;
      const date = extractDateFromUrl(url);

      if (date && date < cutoffDate) {
        batch.delete(doc.ref);
        deletedCount++;
      }
    });

    // Engagez le lot
    await batch.commit();

    // Supprimez la prochaine série de lots
    const lastVisible = snapshot.docs[snapshot.docs.length - 1];
    const nextQuery = urlsCollectionRef.orderBy('__name__').startAfter(lastVisible).limit(batchSize);
    deleteInBatches(nextQuery, resolve, reject);
  };

  // Cette promesse se résoudra une fois que tous les lots auront été traités
  return new Promise((resolve, reject) => {
    deleteInBatches(query, resolve, reject);
  }).then(() => {
    return { deletedCount };
  }).catch((error) => {
    throw new functions.https.HttpsError('internal', error.message, error);
  });
});


function extractDateFromUrl(url) {
  const datePattern = /utm_source=(\d{2})\.(\d{2})\.(\d{2})/;
  const match = url.match(datePattern);

  if (match) {
    const day = parseInt(match[1], 10);
    const month = parseInt(match[2], 10) - 1; // Les mois sont indexés à partir de 0 en JavaScript
    const year = parseInt(match[3], 10) + 2000;

    return new Date(year, month, day);
  }

  return null;
}

exports.deleteOldItems = functions.pubsub.schedule('every 24 hours').onRun(async (context) => {
  const db = admin.firestore();
  const cutoffDate = admin.firestore.Timestamp.fromDate(new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)); // 90 days ago

  const batchSize = 500; // Set batch size
  let numDeleted = 0;

  const deleteBatch = async (query) => {
      const snapshot = await query.get();

      if (snapshot.empty) {
          console.log(`No more documents to delete. Total deleted: ${numDeleted}`);
          return;
      }

      const batch = db.batch();

      snapshot.docs.forEach((doc) => {
          batch.delete(doc.ref);
      });

      await batch.commit();
      numDeleted += snapshot.size;

      console.log(`Batch deleted: ${snapshot.size}. Total deleted so far: ${numDeleted}`);

      // If there are more documents to delete, continue recursively
      if (snapshot.size === batchSize) {
          const lastDoc = snapshot.docs[snapshot.docs.length - 1];
          const nextQuery = db.collection('urls')
              .where('createdAt', '<=', cutoffDate)
              .startAfter(lastDoc)
              .limit(batchSize);
          return deleteBatch(nextQuery);
      } else {
          console.log(`Deletion complete. Total deleted: ${numDeleted}`);
      }
  };

  try {
      const initialQuery = db.collection('urls')
          .where('createdAt', '<=', cutoffDate)
          .limit(batchSize);
      await deleteBatch(initialQuery);
  } catch (error) {
      console.error(`Error during deletion: ${error}`);
  }

  return null;
});