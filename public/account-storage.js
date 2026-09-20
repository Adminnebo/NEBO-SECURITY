/* Separate the normal UI's browser-local keys/contacts by signed-in account.
 * The sole administrator retains the existing v10 store on this origin.
 * This is account organization, not isolation from someone controlling the OS
 * or browser developer tools; IndexedDB is an origin-local device store. */
export function accountDatabaseName(legacyName) {
  const user = globalThis.NEBO_ACCESS?.user;
  if (!user || !/^[a-zA-Z0-9_-]{1,80}$/.test(user.id)) {
    throw new Error('Inicia sesión para acceder a los datos locales de tu cuenta.');
  }
  return user.role === 'admin' ? legacyName : `${legacyName}-account-${user.id}`;
}
