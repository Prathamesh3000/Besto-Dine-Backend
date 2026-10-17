require('dotenv').config();
const { MongoClient } = require('mongodb');
(async () => {
  const c = new MongoClient(process.env.MONGO_URL, { serverSelectionTimeoutMS: 20000 });
  await c.connect();
  const db = c.db();
  const s = await db.stats();
  console.log('DB', db.databaseName, 'collections', s.collections, 'dataMB', (s.dataSize/1048576).toFixed(1), 'storageMB', (s.storageSize/1048576).toFixed(1), 'indexMB', (s.indexSize/1048576).toFixed(1), 'docs', s.objects);
  const cols = await db.listCollections().toArray();
  const rows = [];
  for (const col of cols) {
    try {
      const st = await db.command({ collStats: col.name });
      rows.push({ name: col.name, count: st.count, dataMB: +(st.size/1048576).toFixed(2), storageMB: +(st.storageSize/1048576).toFixed(2), idxMB: +(st.totalIndexSize/1048576).toFixed(2), avgKB: st.count ? +(st.avgObjSize/1024).toFixed(1) : 0, nIdx: st.nindexes });
    } catch (e) { rows.push({ name: col.name, err: e.message }); }
  }
  rows.sort((a,b)=>(b.storageMB||0)+(b.idxMB||0)-((a.storageMB||0)+(a.idxMB||0)));
  console.table(rows.slice(0, 25));
  const rest = await db.collection('restaurants').countDocuments();
  const orders = await db.collection('orders').countDocuments();
  console.log('restaurants', rest, 'orders', orders);
  await c.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
