'use strict';
const TaskOutStore = (() => {
  let database;
  async function open() {
    if (database) return database;
    database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('task-out-v2', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('workspace');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    database.onversionchange = () => { database.close(); database = null; };
    return database;
  }
  async function read() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('workspace', 'readonly');
      const request = tx.objectStore('workspace').get('state');
      request.onsuccess = () => resolve(request.result || TaskOutCore.initial());
      request.onerror = () => reject(request.error);
    });
  }
  async function write(state) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('workspace', 'readwrite');
      tx.objectStore('workspace').put(state, 'state');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || Error('保存失败，请检查浏览器存储空间。'));
      tx.onabort = () => reject(tx.error || Error('保存未完成，原记录已保留。'));
    });
  }
  return {read, write};
})();
