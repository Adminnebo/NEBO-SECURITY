/* Public recipient address book only. Never stores secrets or private CryptoKeys. */
import { validatePublicBundle } from './secure-worker.js';

const DB_NAME = 'nebo-public-contacts-v1';
const STORE = 'contacts';
const MAX_CONTACTS = 50;

function alias(value) {
  if (typeof value !== 'string') throw new Error('Escribe un nombre para el contacto.');
  const name = value.normalize('NFC').trim();
  if (!name || Array.from(name).length > 60 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new Error('El nombre debe tener entre 1 y 60 caracteres, sin saltos de línea.');
  }
  return name;
}

function openDB() {
  if (!globalThis.indexedDB) return Promise.reject(new Error('Este navegador no permite guardar contactos locales.'));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    let rejected = false;
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onerror = () => { rejected = true; reject(new Error('No se pudo abrir la libreta de contactos de este navegador.')); };
    request.onblocked = () => { rejected = true; reject(new Error('Cierra otras pestañas de NEBO y vuelve a abrir los contactos.')); };
    request.onsuccess = () => {
      if (rejected) { request.result.close(); return; }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}

function validDate(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

export async function listContacts() {
  const db = await openDB();
  let records;
  try {
    records = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).getAll();
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(new Error('No se pudieron leer los contactos guardados.'));
    });
  } finally { db.close(); }
  if (records.length > MAX_CONTACTS) throw new Error('La libreta guardada supera el límite de 50 contactos.');
  const contacts = await Promise.all(records.map(async record => {
    if (!record || Object.keys(record).sort().join('|') !== 'createdAt|id|name|publicBundle' || !validDate(record.createdAt)) {
      throw new Error('Hay un contacto guardado con datos inválidos.');
    }
    const name = alias(record.name);
    const publicBundle = await validatePublicBundle(record.publicBundle);
    if (record.id !== publicBundle.fingerprint || record.name !== name) throw new Error('La huella del contacto guardado no coincide.');
    return { id: publicBundle.fingerprint, name, publicBundle, createdAt: record.createdAt };
  }));
  return contacts.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) || a.id.localeCompare(b.id));
}

export async function saveContact(name, bundle) {
  const normalizedName = alias(name);
  const publicBundle = await validatePublicBundle(bundle);
  const id = publicBundle.fingerprint;
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      // Count and upsert share a serialized read/write transaction, including across tabs.
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const existing = store.get(id), count = store.count();
      let gotExisting = false, gotCount = false, result, error;
      const finish = () => {
        if (!gotExisting || !gotCount) return;
        if (!existing.result && count.result >= MAX_CONTACTS) {
          error = new Error('Puedes guardar hasta 50 contactos. Elimina uno antes de añadir otro.');
          tx.abort(); return;
        }
        result = { id, name: normalizedName, publicBundle,
          createdAt: validDate(existing.result?.createdAt) ? existing.result.createdAt : new Date().toISOString() };
        store.put(result);
      };
      existing.onsuccess = () => { gotExisting = true; finish(); };
      count.onsuccess = () => { gotCount = true; finish(); };
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(error || new Error('No se pudo guardar el contacto en este navegador.'));
    });
  } finally { db.close(); }
}

export async function removeContact(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)) throw new Error('La huella del contacto no es válida.');
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = tx.onabort = () => reject(new Error('No se pudo eliminar el contacto.'));
    });
  } finally { db.close(); }
}
