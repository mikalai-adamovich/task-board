/**
 * Tenant slug helpers.
 *
 * A tenant slug is a short, human-readable, URL-safe identifier generated
 * from the workspace name: lowercase `[a-z0-9-]`, no leading/trailing
 * hyphen, max 48 characters, globally unique (uniqueness enforced by the
 * server via a unique index + availability endpoint).
 */

/** Maximum length of a tenant slug */
export const TENANT_SLUG_MAX_LENGTH = 48;

/** Valid tenant slug shape — lowercase alphanumerics and hyphens, no leading/trailing hyphen */
export const TENANT_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Generate a URL-friendly slug from a workspace name.
 *
 * Transliterates non-alphanumeric characters to hyphens, collapses repeated
 * hyphens, trims leading/trailing hyphens, lowercases, and truncates to
 * {@link TENANT_SLUG_MAX_LENGTH} characters (never ending on a hyphen).
 *
 * @example generateSlugFromName('My Workspace!') // 'my-workspace'
 */
export function generateSlugFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics left over from NFKD decomposition
    .replace(/[^a-z0-9]+/g, '-') // transliterate non-alphanumerics to hyphens
    .replace(/-{2,}/g, '-') // collapse repeats
    .replace(/^-+|-+$/g, ''); // trim hyphens

  if (slug.length <= TENANT_SLUG_MAX_LENGTH) {
    return slug;
  }

  return slug.slice(0, TENANT_SLUG_MAX_LENGTH).replace(/-+$/, '');
}

/**
 * Check whether a string satisfies the tenant slug rules
 * (shape + length). Uniqueness is checked server-side against the DB.
 */
export function isValidTenantSlug(slug: string): boolean {
  return slug.length >= 2 && slug.length <= TENANT_SLUG_MAX_LENGTH && TENANT_SLUG_PATTERN.test(slug);
}
