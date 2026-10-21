/**
 * Built-in Microsoft app registered by frilabs (docs/MICROSOFT_FRILABS_APP_SPEC.md): a multi-tenant public client
 * (no secret), so `perch microsoft add` works without an own Entra app registration. The Application (client) ID
 * is not a secret.
 *
 * Empty until the frilabs registration exists: Perch then behaves as before (guided own registration).
 * Order: PERCH_MICROSOFT_CLIENT_ID > ~/.config/perch/microsoft-client-id > this ID.
 */
export const FRILABS_MICROSOFT_CLIENT_ID = '';

/** Name shown in the Microsoft consent screen for the built-in app. */
export const FRILABS_MICROSOFT_APP_NAME = 'Perch (frilabs)';
