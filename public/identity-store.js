/* Browser-local receiver identities. Private keys never enter exported JSON. */
import { generateIdentity, validatePublicBundle } from './secure-worker.js';

const DB_NAME = 'astra-private-identities-v1';
const STORE = 'identities';
const ID = 'current';
let creation;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onerror = () => reject(new Error('No se pudo abrir el almacén de claves de este navegador.'));
    request.onblocked = () => reject(new Error('Cierra otras pestañas de ASTRA y vuelve a intentarlo.'));
    request.onsuccess = () => resolve(request.result);
  });
}

async function readRecord() {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(ID);
      tx.oncomplete = () => resolve(request.result || null);
      tx.onerror = tx.onabort = () => reject(new Error('No se pudo leer tu identidad de recepción.'));
    });
  } finally { db.close(); }
}

async function validateIdentity(record) {
  if (!record) return null;
  const key = record.privateKey;
  if (!(key instanceof CryptoKey) || key.type !== 'private' || key.extractable ||
      key.algorithm.name !== 'ECDH' || key.algorithm.namedCurve !== 'P-256' ||
      !key.usages.includes('deriveBits')) {
    throw new Error('La identidad guardada no es una clave privada válida.');
  }
  const publicBundle = await validatePublicBundle(record.publicBundle);
  // Verify the stored public/private pairing without ever exporting the private key.
  const publicKey = await crypto.subtle.importKey('jwk', publicBundle.publicKey,
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const probe = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const [left, right] = await Promise.all([
    crypto.subtle.deriveBits({ name: 'ECDH', public: probe.publicKey }, key, 256),
    crypto.subtle.deriveBits({ name: 'ECDH', public: publicKey }, probe.privateKey, 256),
  ]);
  const a = new Uint8Array(left), b = new Uint8Array(right);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  a.fill(0); b.fill(0);
  if (difference) throw new Error('La clave privada guardada no corresponde a esta identidad pública.');
  return { privateKey: key, publicBundle, createdAt: record.createdAt || null };
}

export async function loadIdentity() {
  if (!globalThis.indexedDB) throw new Error('Este navegador no permite guardar una identidad. Usa el modo de clave secreta.');
  return validateIdentity(await readRecord());
}

export async function createIdentity() {
  if (creation) return creation;
  creation = (async () => {
    const existing = await loadIdentity();
    if (existing) return existing;
    const generated = await generateIdentity();
    const candidate = { privateKey: generated.privateKey, publicBundle: generated.publicBundle,
      createdAt: new Date().toISOString() };
    const db = await openDB();
    let chosen;
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite'), store = tx.objectStore(STORE);
        const request = store.get(ID);
        request.onsuccess = () => {
          chosen = request.result || candidate;
          if (!request.result) store.put(candidate, ID);
        };
        tx.oncomplete = resolve;
        tx.onerror = tx.onabort = () => reject(new Error('No se pudo guardar la clave privada. No se creó una identidad utilizable.'));
      });
    } finally { db.close(); }
    return validateIdentity(chosen);
  })();
  try { return await creation; } finally { creation = null; }
}

export async function exportPublicIdentity(identity) {
  const selected = identity || await loadIdentity();
  if (!selected) throw new Error('Primero crea tu identidad de recepción.');
  const publicBundle = await validatePublicBundle(selected.publicBundle);
  return JSON.stringify(publicBundle, null, 2) + '\n';
}

export async function clearIdentity() {
  if (creation) await creation;
  const db = await openDB();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(ID);
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(new Error('No se pudo eliminar la identidad.'));
    });
  } finally { db.close(); }
}

export async function loadRecipientBundle(input) {
  if (input instanceof Blob && input.size > 8192) throw new Error('La identidad pública supera el tamaño permitido.');
  const text = typeof input === 'string' ? input : input instanceof Blob ? await input.text() : null;
  if (text === null || text.length > 8192) throw new Error('Selecciona un archivo JSON de identidad pública válido.');
  let bundle;
  try { bundle = JSON.parse(text); } catch { throw new Error('El archivo de identidad pública no contiene JSON válido.'); }
  return validatePublicBundle(bundle);
}

export async function fingerprintPublicBundle(bundle) {
  return (await validatePublicBundle(bundle)).fingerprint;
}
